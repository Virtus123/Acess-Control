import { asyncHandler } from '../middleware/errorHandler.js';
import fs from 'fs/promises';
import { join } from 'path';
import path from 'path';
import { createReadStream } from 'fs';

const MAX_AUTHOR = 100;
const MAX_BODY = 10000;

const ensuredTenants = new Set();
const ensuredAttachmentTenants = new Set();

async function ensureShiftNotesTable(db, tenantId) {
  if (ensuredTenants.has(tenantId)) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shift_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      author_label TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shift_notes_tenant_created ON shift_notes(tenant_id, created_at DESC);
  `);
  ensuredTenants.add(tenantId);
}

async function ensureAttachmentsTable(db, tenantId) {
  if (ensuredAttachmentTenants.has(tenantId)) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shift_note_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      note_id INTEGER NOT NULL,
      uploaded_by_user_id INTEGER,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_note_attachments_note ON shift_note_attachments(note_id, tenant_id);
  `);
  ensuredAttachmentTenants.add(tenantId);
}

function sanitize(str, max) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

function isImage(mimeType) {
  return mimeType && mimeType.startsWith('image/');
}

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureShiftNotesTable(db, tenantId);
  await ensureAttachmentsTable(db, tenantId);

  const rows = await db.all(
    `SELECT id, author_label, body, created_by_user_id, created_at, updated_at
     FROM shift_notes
     WHERE tenant_id = ?
     ORDER BY datetime(created_at) DESC`,
    [tenantId]
  );

  // Load attachments for all notes in one query
  const noteIds = rows.map(r => r.id);
  let attachments = [];
  if (noteIds.length > 0) {
    const placeholders = noteIds.map(() => '?').join(',');
    attachments = await db.all(
      `SELECT id, note_id, original_name, stored_name, mime_type, size, created_at
       FROM shift_note_attachments
       WHERE note_id IN (${placeholders}) AND tenant_id = ?
       ORDER BY created_at ASC`,
      [...noteIds, tenantId]
    );
  }

  const attachmentsByNote = {};
  for (const att of attachments) {
    if (!attachmentsByNote[att.note_id]) attachmentsByNote[att.note_id] = [];
    attachmentsByNote[att.note_id].push({
      id: att.id,
      original_name: att.original_name,
      mime_type: att.mime_type,
      size: att.size,
      created_at: att.created_at
    });
  }

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      author_label: r.author_label,
      body: r.body,
      created_by_user_id: r.created_by_user_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      attachments: attachmentsByNote[r.id] || []
    }))
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureShiftNotesTable(db, tenantId);

  const author_label = sanitize(req.body?.author_label, MAX_AUTHOR);
  const body = sanitize(req.body?.body, MAX_BODY);

  if (!author_label) {
    return res.status(400).json({ success: false, message: 'Informe o autor / porteiro.' });
  }
  if (!body) {
    return res.status(400).json({ success: false, message: 'Informe o texto da anotação.' });
  }

  const userId = req.user?.id != null ? parseInt(req.user.id, 10) : null;

  const result = await db.run(
    `INSERT INTO shift_notes (tenant_id, author_label, body, created_by_user_id)
     VALUES (?, ?, ?, ?)`,
    [tenantId, author_label, body, Number.isFinite(userId) ? userId : null]
  );

  const row = await db.get(
    `SELECT id, author_label, body, created_by_user_id, created_at, updated_at
     FROM shift_notes WHERE id = ? AND tenant_id = ?`,
    [result.lastID, tenantId]
  );

  res.status(201).json({ success: true, data: { ...row, attachments: [] } });
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureShiftNotesTable(db, tenantId);

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  const author_label = sanitize(req.body?.author_label, MAX_AUTHOR);
  const body = sanitize(req.body?.body, MAX_BODY);

  if (!author_label) {
    return res.status(400).json({ success: false, message: 'Informe o autor / porteiro.' });
  }
  if (!body) {
    return res.status(400).json({ success: false, message: 'Informe o texto da anotação.' });
  }

  const result = await db.run(
    `UPDATE shift_notes
     SET author_label = ?, body = ?, updated_at = datetime('now')
     WHERE id = ? AND tenant_id = ?`,
    [author_label, body, id, tenantId]
  );

  if (!result.changes) {
    return res.status(404).json({ success: false, message: 'Anotação não encontrada.' });
  }

  const row = await db.get(
    `SELECT id, author_label, body, created_by_user_id, created_at, updated_at
     FROM shift_notes WHERE id = ? AND tenant_id = ?`,
    [id, tenantId]
  );

  res.json({ success: true, data: row });
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureShiftNotesTable(db, tenantId);
  await ensureAttachmentsTable(db, tenantId);

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  // Delete attachment files first
  const attachments = await db.all(
    `SELECT file_path FROM shift_note_attachments WHERE note_id = ? AND tenant_id = ?`,
    [id, tenantId]
  );
  for (const att of attachments) {
    try {
      await fs.unlink(join(process.cwd(), att.file_path));
    } catch (_) {}
  }
  await db.run(`DELETE FROM shift_note_attachments WHERE note_id = ? AND tenant_id = ?`, [id, tenantId]);

  const result = await db.run(
    `DELETE FROM shift_notes WHERE id = ? AND tenant_id = ?`,
    [id, tenantId]
  );

  if (!result.changes) {
    return res.status(404).json({ success: false, message: 'Anotação não encontrada.' });
  }

  res.json({ success: true, message: 'Anotação excluída.' });
});

// ─────────────────────────────────────────────
//  ATTACHMENTS
// ─────────────────────────────────────────────

export const uploadAttachment = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureShiftNotesTable(db, tenantId);
  await ensureAttachmentsTable(db, tenantId);

  const noteId = parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId)) {
    return res.status(400).json({ success: false, message: 'ID de anotação inválido.' });
  }

  // Verify note belongs to tenant
  const note = await db.get(
    `SELECT id FROM shift_notes WHERE id = ? AND tenant_id = ?`,
    [noteId, tenantId]
  );
  if (!note) {
    // Remove uploaded file if note not found
    if (req.file) {
      try { await fs.unlink(req.file.path); } catch (_) {}
    }
    return res.status(404).json({ success: false, message: 'Anotação não encontrada.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
  }

  const userId = req.user?.id || null;
  // file_path stored relative to process.cwd()
  const relativePath = `public/uploads/imports/${tenantId}/${req.file.filename}`;

  const result = await db.run(
    `INSERT INTO shift_note_attachments (tenant_id, note_id, uploaded_by_user_id, original_name, stored_name, file_path, mime_type, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, noteId, userId, req.file.originalname, req.file.filename, relativePath, req.file.mimetype, req.file.size]
  );

  const att = await db.get(
    `SELECT id, note_id, original_name, stored_name, mime_type, size, created_at
     FROM shift_note_attachments WHERE id = ?`,
    [result.lastID]
  );

  res.status(201).json({ success: true, data: att });
});

export const listAttachments = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureAttachmentsTable(db, tenantId);

  const noteId = parseInt(req.params.id, 10);
  if (!Number.isFinite(noteId)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  const attachments = await db.all(
    `SELECT id, note_id, original_name, stored_name, mime_type, size, created_at
     FROM shift_note_attachments
     WHERE note_id = ? AND tenant_id = ?
     ORDER BY created_at ASC`,
    [noteId, tenantId]
  );

  res.json({ success: true, data: attachments });
});

export const deleteAttachment = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureAttachmentsTable(db, tenantId);

  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!Number.isFinite(attachmentId)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  const att = await db.get(
    `SELECT id, file_path FROM shift_note_attachments WHERE id = ? AND tenant_id = ?`,
    [attachmentId, tenantId]
  );

  if (!att) {
    return res.status(404).json({ success: false, message: 'Anexo não encontrado.' });
  }

  // Delete the physical file
  try {
    await fs.unlink(join(process.cwd(), att.file_path));
  } catch (_) {}

  await db.run(`DELETE FROM shift_note_attachments WHERE id = ?`, [attachmentId]);

  res.json({ success: true, message: 'Anexo excluído.' });
});

export const viewAttachment = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureAttachmentsTable(db, tenantId);

  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!Number.isFinite(attachmentId)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  const att = await db.get(
    `SELECT id, original_name, stored_name, file_path, mime_type
     FROM shift_note_attachments WHERE id = ? AND tenant_id = ?`,
    [attachmentId, tenantId]
  );

  if (!att) {
    return res.status(404).json({ success: false, message: 'Anexo não encontrado.' });
  }

  const fullPath = join(process.cwd(), att.file_path);

  try {
    await fs.access(fullPath);
  } catch (_) {
    return res.status(404).json({ success: false, message: 'Arquivo não encontrado no servidor.' });
  }

  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  createReadStream(fullPath).pipe(res);
});

export const downloadAttachment = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  await ensureAttachmentsTable(db, tenantId);

  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!Number.isFinite(attachmentId)) {
    return res.status(400).json({ success: false, message: 'ID inválido.' });
  }

  const att = await db.get(
    `SELECT id, original_name, stored_name, file_path, mime_type
     FROM shift_note_attachments WHERE id = ? AND tenant_id = ?`,
    [attachmentId, tenantId]
  );

  if (!att) {
    return res.status(404).json({ success: false, message: 'Anexo não encontrado.' });
  }

  const fullPath = join(process.cwd(), att.file_path);

  try {
    await fs.access(fullPath);
  } catch (_) {
    return res.status(404).json({ success: false, message: 'Arquivo não encontrado no servidor.' });
  }

  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.original_name)}"`);
  createReadStream(fullPath).pipe(res);
});

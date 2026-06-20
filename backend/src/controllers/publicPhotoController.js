// Link público de auto-cadastro de foto.
//
// Cliente MAMCONTROL gera um link único por tenant e envia pras pessoas dele.
// Pessoa abre → digita matrícula → tira foto → upload. Foto entra no cadastro
// e dispara push pra equipamentos autorizados pela regra de acesso.
//
// Segurança nível A: só matrícula (sem confirmação extra). Rate limit por IP
// pra evitar brute-force de matrículas.

import crypto from 'crypto';
import { asyncHandler } from '../middleware/errorHandler.js';
import dbManager from '../config/database.js';
import photoService from '../services/photoService.js';
import { enqueueForAuthorizedDevices } from '../services/pushOutbox.js';
import { toDeviceUserId } from '../services/deviceUserId.js';

// ============================================
// RATE LIMIT por IP (in-memory, simples)
// ============================================
const LOOKUP_LIMIT = parseInt(process.env.PHOTO_LOOKUP_PER_MIN || '10', 10);
const UPLOAD_LIMIT = parseInt(process.env.PHOTO_UPLOAD_PER_MIN || '3', 10);
const FAILURE_BAN_THRESHOLD = parseInt(process.env.PHOTO_FAILURE_BAN || '30', 10);
const FAILURE_BAN_WINDOW_MS = 60 * 60 * 1000;
const WINDOW_MS = 60 * 1000;

const lookupHits = new Map();   // ip → [timestamps...]
const uploadHits = new Map();   // ip → [timestamps...]
const failureHits = new Map();  // ip → [timestamps...] (matrículas não encontradas)

function rateLimit(map, ip, limit, windowMs = WINDOW_MS) {
  const now = Date.now();
  const arr = (map.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  map.set(ip, arr);
  return arr.length <= limit;
}

function isIpBanned(ip) {
  const now = Date.now();
  const arr = (failureHits.get(ip) || []).filter(t => now - t < FAILURE_BAN_WINDOW_MS);
  failureHits.set(ip, arr);
  return arr.length >= FAILURE_BAN_THRESHOLD;
}

function recordFailure(ip) {
  const arr = failureHits.get(ip) || [];
  arr.push(Date.now());
  failureHits.set(ip, arr);
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || '').replace(/^::ffff:/, '');
}

// ============================================
// Helper: garante coluna public_photo_token na master
// ============================================
async function ensurePhotoTokenSchema() {
  const master = await dbManager.getConnection('mamcontrolmam');
  try {
    await master.exec(`ALTER TABLE tenants ADD COLUMN public_photo_token TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) {
      console.warn('[publicPhoto] alter tenants:', e.message);
    }
  }
  try {
    await master.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_photo_token ON tenants(public_photo_token)
       WHERE public_photo_token IS NOT NULL`
    );
  } catch {}
  return master;
}

// ============================================
// Helper: resolve token → tenantId (com cache curto)
// ============================================
const tokenCache = new Map(); // token → { tenantId, expiresAt }
const TOKEN_CACHE_TTL = 60_000;

async function resolveTokenToTenant(token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.tenantId;

  const master = await ensurePhotoTokenSchema();
  const row = await master.get(
    `SELECT tenant_id FROM tenants WHERE public_photo_token = ? LIMIT 1`,
    [token]
  );
  if (!row) return null;
  tokenCache.set(token, { tenantId: row.tenant_id, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  return row.tenant_id;
}

function invalidateToken(token) {
  tokenCache.delete(token);
}

// ============================================
// 1. GERAR / REVOGAR link público (autenticado, admin do tenant)
// ============================================

/**
 * GET /api/admin-photo-link
 * Retorna o link atual do tenant (ou null se não tem).
 */
export const getPhotoLink = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ success: false, message: 'tenant required' });

  const master = await ensurePhotoTokenSchema();
  const row = await master.get(
    `SELECT public_photo_token FROM tenants WHERE tenant_id = ?`,
    [tenantId]
  );
  const token = row?.public_photo_token || null;
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    data: {
      token,
      url: token ? `${baseUrl}/foto/${token}` : null,
    },
  });
});

/**
 * POST /api/admin-photo-link/generate
 * Gera token novo (substitui o anterior — invalida link antigo).
 */
export const generatePhotoLink = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ success: false, message: 'tenant required' });

  const master = await ensurePhotoTokenSchema();
  // 32 chars hex = 16 bytes random — colisão praticamente impossível
  const token = crypto.randomBytes(16).toString('hex');

  // Pega o token antigo pra invalidar cache
  const old = await master.get(
    `SELECT public_photo_token FROM tenants WHERE tenant_id = ?`,
    [tenantId]
  );
  if (old?.public_photo_token) invalidateToken(old.public_photo_token);

  await master.run(
    `UPDATE tenants SET public_photo_token = ? WHERE tenant_id = ?`,
    [token, tenantId]
  );

  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    data: {
      token,
      url: `${baseUrl}/foto/${token}`,
    },
    message: 'Link gerado. O link anterior foi invalidado.',
  });
});

/**
 * DELETE /api/admin-photo-link
 * Revoga link sem gerar novo.
 */
export const revokePhotoLink = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  if (!tenantId) return res.status(400).json({ success: false, message: 'tenant required' });

  const master = await ensurePhotoTokenSchema();
  const old = await master.get(
    `SELECT public_photo_token FROM tenants WHERE tenant_id = ?`,
    [tenantId]
  );
  if (old?.public_photo_token) invalidateToken(old.public_photo_token);

  await master.run(
    `UPDATE tenants SET public_photo_token = NULL WHERE tenant_id = ?`,
    [tenantId]
  );

  res.json({ success: true, message: 'Link revogado' });
});

// ============================================
// 2. ENDPOINTS PÚBLICOS (sem autenticação)
// ============================================

/**
 * POST /api/public-photo/:token/lookup
 * Body: { query: "matricula ou nome" }
 * Retorna: { data: [{id, name, has_photo}] } (máx 10, sem dados sensíveis)
 */
export const publicLookup = asyncHandler(async (req, res) => {
  const ip = getClientIp(req);

  if (isIpBanned(ip)) {
    return res.status(429).json({ success: false, message: 'IP temporariamente bloqueado por excesso de buscas falhas' });
  }
  if (!rateLimit(lookupHits, ip, LOOKUP_LIMIT)) {
    return res.status(429).json({ success: false, message: 'Muitas buscas. Aguarde 1 minuto.' });
  }

  const { token } = req.params;
  const tenantId = await resolveTokenToTenant(token);
  if (!tenantId) {
    return res.status(404).json({ success: false, message: 'Link inválido ou expirado' });
  }

  const query = String(req.body?.query || '').trim();
  if (!query || query.length < 2) {
    return res.status(400).json({ success: false, message: 'Digite ao menos 2 caracteres' });
  }
  if (query.length > 100) {
    return res.status(400).json({ success: false, message: 'Busca muito longa' });
  }

  const db = await dbManager.getConnection(tenantId);

  // Busca: prioriza matrícula EXATA; senão nome LIKE
  const exact = await db.all(
    `SELECT id, name, registration_number, photo_url
     FROM persons
     WHERE status = 'active' AND registration_number = ?
     LIMIT 10`,
    [query]
  );

  let rows = exact;
  if (rows.length === 0) {
    // Fallback: busca por nome (case insensitive)
    const like = `%${query.replace(/[%_]/g, '\\$&')}%`;
    rows = await db.all(
      `SELECT id, name, registration_number, photo_url
       FROM persons
       WHERE status = 'active' AND LOWER(name) LIKE LOWER(?) ESCAPE '\\'
       ORDER BY name LIMIT 10`,
      [like]
    );
  }

  if (rows.length === 0) {
    recordFailure(ip);
    return res.json({ success: true, data: [] });
  }

  // Devolve só o mínimo (não expõe CPF, email, etc)
  const data = rows.map(r => ({
    id: r.id,
    name: r.name,
    has_photo: !!r.photo_url,
    // matrícula só mostra os últimos 4 dígitos pra não vazar lista completa
    registration_masked: r.registration_number
      ? '****' + String(r.registration_number).slice(-4)
      : null,
  }));

  res.json({ success: true, data });
});

/**
 * POST /api/public-photo/:token/upload
 * Body: { personId, photoBase64 }
 * Salva foto + dispara push pra equips autorizados.
 */
export const publicUpload = asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  if (!rateLimit(uploadHits, ip, UPLOAD_LIMIT)) {
    return res.status(429).json({ success: false, message: 'Muitos uploads. Aguarde 1 minuto.' });
  }

  const { token } = req.params;
  const tenantId = await resolveTokenToTenant(token);
  if (!tenantId) {
    return res.status(404).json({ success: false, message: 'Link inválido ou expirado' });
  }

  const personId = parseInt(req.body?.personId, 10);
  const photoBase64 = req.body?.photoBase64;

  if (!personId || Number.isNaN(personId)) {
    return res.status(400).json({ success: false, message: 'personId obrigatório' });
  }
  if (!photoBase64 || typeof photoBase64 !== 'string') {
    return res.status(400).json({ success: false, message: 'photoBase64 obrigatório' });
  }
  // Limite ~2MB em base64 = ~2.7MB
  if (photoBase64.length > 2_800_000) {
    return res.status(400).json({ success: false, message: 'Foto muito grande (máx 2MB)' });
  }

  const db = await dbManager.getConnection(tenantId);

  const person = await db.get(
    `SELECT id, name, registration_number FROM persons WHERE id = ? AND status = 'active'`,
    [personId]
  );
  if (!person) {
    return res.status(404).json({ success: false, message: 'Pessoa não encontrada' });
  }

  // Processa + salva arquivo (mesmo helper do controller normal)
  let processed;
  try {
    const desiredName = `person_${String(person.id).padStart(6, '0')}`;
    processed = await photoService.processBase64Photo(photoBase64, 'person', desiredName, tenantId);
  } catch (err) {
    console.error('[publicPhoto upload] processBase64Photo falhou:', err.message);
    return res.status(400).json({ success: false, message: 'Foto inválida' });
  }

  const newPhotoUrl = processed.url;

  // Pega foto antiga pra deletar depois
  const oldRow = await db.get(`SELECT photo_url FROM persons WHERE id = ?`, [personId]);

  await db.run(
    `UPDATE persons SET photo_url = ?, updated_at = ? WHERE id = ?`,
    [newPhotoUrl, new Date().toISOString(), personId]
  );

  // Apaga foto antiga (best-effort)
  if (oldRow?.photo_url && oldRow.photo_url !== newPhotoUrl) {
    try {
      const oldFilename = oldRow.photo_url.split('/').pop().split('?')[0];
      await photoService.deletePhoto(oldFilename, 'person');
    } catch (e) {
      console.warn('[publicPhoto] erro deletando foto antiga:', e.message);
    }
  }

  // Dispara push: só pra equips autorizados pela regra de acesso.
  // Como é UPDATE de pessoa existente, mesma lógica do personController.update.
  try {
    const equipUserId = toDeviceUserId('person', person.id, person.registration_number);
    await enqueueForAuthorizedDevices(db, tenantId, 'person', person.id, {
      onAuthorized: async (deviceId) => {
        // Só user_set_image — não recadastra user. Pessoa já existe nos equips.
        const fs = await import('fs/promises');
        const { join } = await import('path');
        const fileBase64 = await loadPhotoBase64(newPhotoUrl);
        if (!fileBase64) return [];
        return [{
          deviceId, origin: `person:public_photo:${person.id}`,
          endpoint: 'user_set_image',
          queryString: `user_id=${equipUserId}&timestamp=${Math.floor(Date.now()/1000)}&match=0`,
          body: fileBase64,
          contentType: 'application/octet-stream',
        }];
      },
    });
  } catch (err) {
    console.error('[publicPhoto upload] push enqueue falhou:', err.message);
  }

  res.json({
    success: true,
    message: 'Foto enviada com sucesso',
  });
});

async function loadPhotoBase64(photoUrl) {
  if (!photoUrl) return null;
  try {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const rel = photoUrl.replace(/^\//, '');
    for (const p of [
      join(process.cwd(), 'public', rel),
      join(process.cwd(), 'uploads', rel),
      join(process.cwd(), rel),
    ]) {
      try { return (await readFile(p)).toString('base64'); } catch {}
    }
  } catch {}
  return null;
}

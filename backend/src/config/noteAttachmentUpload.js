import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { join } from 'path';

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'csv', 'xls', 'xlsx', 'doc', 'docx'];

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const tenantId = req.tenantId || 'default';
    const dir = join(process.cwd(), 'public', 'uploads', 'imports', tenantId);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const noteId = req.params.id || '0';
    const userId = req.user?.id || 'anon';
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `note${noteId}_user${userId}_${timestamp}_${base}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de arquivo não permitido. Permitidos: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
};

export const noteAttachmentUpload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter
});

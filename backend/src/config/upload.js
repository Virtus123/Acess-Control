import multer from 'multer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadDir = join(process.cwd(), 'public', 'uploads', 'photos');
const maxSize = parseInt(process.env.UPLOAD_MAX_SIZE) || 2147483648; // 2GB default for large imports
const allowedTypes = (process.env.UPLOAD_ALLOWED_TYPES || 'jpg,jpeg,png').split(',');

const ensureUploadDir = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    console.error('Failed to create upload directory:', error);
  }
};

await ensureUploadDir(uploadDir);

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const type = req.body?.type || (req.path?.includes('person') ? 'person' : 'visitor');
    const dir = join(uploadDir, type);
    await ensureUploadDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    const type = req.body?.type || (req.path?.includes('person') ? 'person' : 'visitor');
    cb(null, `${type}_${timestamp}_${random}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase().substring(1);
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Tipo de arquivo não permitido. Permitidos: ${allowedTypes.join(', ')}`), false);
  }
};

export const upload = multer({
  storage,
  limits: { fileSize: maxSize },
  fileFilter
});

export { uploadDir, maxSize, allowedTypes };


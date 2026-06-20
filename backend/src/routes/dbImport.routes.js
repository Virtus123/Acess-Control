import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { importDatabase, previewDatabase } from '../controllers/dbImportController.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Configurar multer para aceitar arquivos .db
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'public/uploads/imports/';
    // Criar diretório se não existir
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `import-${unique}.db`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB máximo
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos .db, .sqlite ou .sqlite3 são permitidos'));
    }
  }
});

// Preview: ver o que tem no banco antes de importar
router.post(
  '/preview',
  authenticate,
  requireAdmin,
  upload.single('database'),
  previewDatabase
);

// Importar banco de dados
router.post(
  '/import',
  authenticate,
  requireAdmin,
  upload.single('database'),
  importDatabase
);

export default router;

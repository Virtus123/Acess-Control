// Rotas do link público de auto-cadastro de foto.
// Algumas exigem autenticação (gerenciar link), outras são públicas (upload).

import express from 'express';
import {
  getPhotoLink, generatePhotoLink, revokePhotoLink,
  publicLookup, publicUpload,
} from '../controllers/publicPhotoController.js';

const router = express.Router();

// Body grande pra foto base64 (foto + headers = até 3MB)
const bodyParser = express.json({ limit: '4mb' });

// ============================================
// Rotas autenticadas — cliente Acess Control gerencia o link
// ============================================
// (montadas em /api/admin-photo-link via index.js depois do tenantMiddleware)
export const adminRouter = express.Router();
adminRouter.use(bodyParser);
adminRouter.get('/', getPhotoLink);
adminRouter.post('/generate', generatePhotoLink);
adminRouter.delete('/', revokePhotoLink);

// ============================================
// Rotas públicas — pessoa abre via link
// ============================================
// (montadas em /api/public-photo via index.js ANTES do tenantMiddleware)
export const publicRouter = express.Router();
publicRouter.use(bodyParser);
publicRouter.post('/:token/lookup', publicLookup);
publicRouter.post('/:token/upload', publicUpload);

export default router;

import express from 'express';
import importController from '../controllers/importController.js';
import { importLegacyDatabase } from '../controllers/acessControlImportController.js';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Todas as rotas de importação precisam de autenticação
router.use(authenticate);

// Configure multer for CSV/ZIP file uploads
const upload = multer({
    storage: multer.diskStorage({
        destination: async (req, file, cb) => {
            const path = await import('path');
            const fs = await import('fs');
            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'imports');
            await fs.promises.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + '-' + file.originalname);
        }
    }),
    limits: { fileSize: 2147483648 }, // 2GB for large imports
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.csv') || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo inválido'));
        }
    }
});

// Configure multer for .db file uploads (AcessControl import)
const uploadDb = multer({
    storage: multer.diskStorage({
        destination: async (req, file, cb) => {
            const path = await import('path');
            const fs = await import('fs');
            const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'imports');
            await fs.promises.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + '-' + file.originalname);
        }
    }),
    limits: { fileSize: 524288000 }, // 500 MB
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.db')) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo inválido. Envie um arquivo .db'));
        }
    }
});

/**
 * @swagger
 * tags:
 *   name: Import
 *   description: Importação de dados (CSV/ZIP)
 */

/**
 * @swagger
 * /imports:
 *   post:
 *     summary: Realiza o upload e inicia a importação de dados
 *     tags: [Import]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               csv:
 *                 type: string
 *                 format: binary
 *               zip:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Importação iniciada
 */
router.post('/', upload.fields([
    { name: 'csv', maxCount: 1 },
    { name: 'zip', maxCount: 1 }
]), (req, res) => importController.uploadAndStartImport(req, res));

/**
 * @swagger
 * /imports/{tenant_id}:
 *   get:
 *     summary: Lista as importações realizadas por um tenant
 *     tags: [Import]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: tenant_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de importações
 */
router.get('/:tenant_id', (req, res) => importController.listImports(req, res));

/**
 * @swagger
 * /imports/{tenant_id}/{import_id}/status:
 *   get:
 *     summary: Obtém o status de uma importação específica
 *     tags: [Import]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: tenant_id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: import_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Status da importação
 */
router.get('/:tenant_id/:import_id/status', (req, res) => importController.getImportStatus(req, res));

/**
 * @swagger
 * /imports/idsecure:
 *   post:
 *     summary: Inicia a importação IDSecure (Legacy)
 *     tags: [Import]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Importação iniciada
 */
import idsecureController from '../controllers/idsecureController.js';
router.post('/idsecure', (req, res) => idsecureController.startImport(req, res));

// AcessControl: download photos from VPS database
router.post('/acesscontrol', uploadDb.single('db'), importLegacyDatabase);

export default router;

import express from 'express';
import {
  list,
  getActive,
  getById,
  create,
  update,
  registerExit,
  uploadPhoto,
  deleteVisitor,
  getStats,
  inactivateVisitor,
  reactivateVisitor,
  bulkInactivate,
  forceDeleteVisitor
} from '../controllers/visitorController.js';
import { promoteVisitorToPerson } from '../controllers/promoteVisitorController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

import { upload } from '../config/upload.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Visitors
 *   description: Gerenciamento de visitantes
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Visitor:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         cpf:
 *           type: string
 *         rg:
 *           type: string
 *         email:
 *           type: string
 *         cellphone:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, inactive]
 *         group_id:
 *           type: integer
 *         company_id:
 *           type: integer
 *         photo_url:
 *           type: string
 *         visit_reason:
 *           type: string
 *         entry_time:
 *           type: string
 *           format: date-time
 */

router.use(authenticate);

/**
 * @swagger
 * /visitors:
 *   get:
 *     summary: Lista todos os visitantes
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Termo de busca
 *     responses:
 *       200:
 *         description: Lista de visitantes retornada com sucesso
 */
router.get('/', requirePermission('visitors'), list);

/**
 * @swagger
 * /visitors/active:
 *   get:
 *     summary: Lista apenas visitantes ativos (presentes)
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de visitantes ativos
 */
router.get('/active', requirePermission('visitors'), getActive);

/**
 * @swagger
 * /visitors/stats:
 *   get:
 *     summary: Obtém estatísticas de visitantes
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas retornadas com sucesso
 */
router.get('/stats', requirePermission('visitors'), getStats);

/**
 * @swagger
 * /visitors/bulk-inactivate:
 *   post:
 *     summary: Inativa vários visitantes de uma vez (Saída em massa)
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Visitantes inativados com sucesso
 */
router.post('/bulk-inactivate', requirePermission('visitors'), bulkInactivate);

/**
 * @swagger
 * /visitors/{id}:
 *   get:
 *     summary: Obtém detalhes de um visitante pelo ID
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do visitante
 */
router.get('/:id', requirePermission('visitors'), getById);

/**
 * @swagger
 * /visitors:
 *   post:
 *     summary: Cria um novo visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Visitor'
 *     responses:
 *       201:
 *         description: Visitante criado com sucesso
 */
router.post('/', requirePermission('visitors'), create);

/**
 * @swagger
 * /visitors/{id}:
 *   put:
 *     summary: Atualiza os dados de um visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Visitor'
 *     responses:
 *       200:
 *         description: Visitante atualizado com sucesso
 */
router.put('/:id', requirePermission('visitors'), update);

/**
 * @swagger
 * /visitors/{id}/exit:
 *   put:
 *     summary: Registra a saída de um visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Saída registrada com sucesso
 */
router.put('/:id/exit', requirePermission('visitors'), registerExit);

/**
 * @swagger
 * /visitors/{id}/inactivate:
 *   post:
 *     summary: Inativa um visitante manualmente
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Visitante inativado
 */
router.post('/:id/inactivate', requirePermission('visitors'), inactivateVisitor);

/**
 * @swagger
 * /visitors/{id}/reactivate:
 *   post:
 *     summary: Reativa um visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Visitante reativado
 */
router.post('/:id/reactivate', requirePermission('visitors'), reactivateVisitor);

/**
 * @swagger
 * /visitors/{id}/force:
 *   delete:
 *     summary: Exclui permanentemente um visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Visitante excluído
 */
router.delete('/:id/force', requirePermission('visitors'), forceDeleteVisitor);

/**
 * @swagger
 * /visitors/{id}:
 *   delete:
 *     summary: Remove um visitante (Soft Delete)
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Visitante removido com sucesso
 */
router.delete('/:id', requirePermission('visitors'), deleteVisitor);

/**
 * @swagger
 * /visitors/{id}/photo:
 *   post:
 *     summary: Faz o upload da foto de um visitante
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               photo:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Foto salva com sucesso
 */
router.post('/:id/photo', requirePermission('visitors'), upload.single('photo'), uploadPhoto);

/**
 * @swagger
 * /visitors/{id}/promote:
 *   post:
 *     summary: "Promove um visitante para o cadastro de pessoas (Ex: Visitante vira funcionário/morador)"
 *     tags: [Visitors]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Visitante promovido com sucesso
 */
router.post('/:id/promote', requirePermission('visitors'), promoteVisitorToPerson);

export default router;

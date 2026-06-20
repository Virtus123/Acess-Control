import express from 'express';
import {
  list,
  getById,
  create,
  update,
  addOwner,
  removeOwner,
  remove,
  restore,
  getOwners
} from '../controllers/companyController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';


const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Companies
 *   description: Gerenciamento de empresas/unidades
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Company:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         document_number:
 *           type: string
 *         email:
 *           type: string
 *         phone:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, inactive]
 */

router.use(authenticate);

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: Lista todas as empresas
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de empresas retornada com sucesso
 */
router.get('/', requirePermission('companies'), list);

/**
 * @swagger
 * /companies/{id}:
 *   get:
 *     summary: Obtém detalhes de uma empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados da empresa
 */
router.get('/:id', requirePermission('companies'), getById);

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Cria uma nova empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Company'
 *     responses:
 *       201:
 *         description: Empresa criada com sucesso
 */
router.post('/', requirePermission('companies'), create);

/**
 * @swagger
 * /companies/{id}:
 *   put:
 *     summary: Atualiza uma empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Empresa atualizada
 */
router.put('/:id', requirePermission('companies'), update);

/**
 * @swagger
 * /companies/{id}/owners:
 *   post:
 *     summary: Adiciona um proprietário/responsável à empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Proprietário adicionado
 */
router.post('/:id/owners', requirePermission('companies'), addOwner);

/**
 * @swagger
 * /companies/{id}/owners/{personId}:
 *   delete:
 *     summary: Remove um proprietário da empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Proprietário removido
 */
router.delete('/:id/owners/:personId', requirePermission('companies'), removeOwner);

/**
 * @swagger
 * /companies/{id}:
 *   delete:
 *     summary: Remove uma empresa (Soft Delete)
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Empresa removida
 */
router.delete('/:id', requirePermission('companies'), remove);

/**
 * @swagger
 * /companies/{id}/restore:
 *   post:
 *     summary: Restaura uma empresa removida
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Empresa restaurada
 */
router.post('/:id/restore', requirePermission('companies'), restore);

/**
 * @swagger
 * /companies/{id}/owners:
 *   get:
 *     summary: Lista os proprietários de uma empresa
 *     tags: [Companies]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de proprietários
 */
router.get('/:id/owners', requirePermission('companies'), getOwners);

export default router;




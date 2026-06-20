import express from 'express';
import {
  list,
  getById,
  create,
  update,
  remove
} from '../controllers/groupController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';


const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Groups
 *   description: Gerenciamento de grupos de acesso
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Group:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, inactive]
 */

router.use(authenticate);

/**
 * @swagger
 * /groups:
 *   get:
 *     summary: Lista todos os grupos
 *     tags: [Groups]
 *     responses:
 *       200:
 *         description: Lista de grupos retornada com sucesso
 */
router.get('/', requirePermission('groups'), list);

/**
 * @swagger
 * /groups/{id}:
 *   get:
 *     summary: Obtém detalhes de um grupo
 *     tags: [Groups]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados do grupo
 */
router.get('/:id', requirePermission('groups'), getById);

/**
 * @swagger
 * /groups:
 *   post:
 *     summary: Cria um novo grupo
 *     tags: [Groups]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Group'
 *     responses:
 *       201:
 *         description: Grupo criado com sucesso
 */
router.post('/', requirePermission('groups'), create);

/**
 * @swagger
 * /groups/{id}:
 *   put:
 *     summary: Atualiza um grupo
 *     tags: [Groups]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Grupo atualizado
 */
router.put('/:id', requirePermission('groups'), update);

/**
 * @swagger
 * /groups/{id}:
 *   delete:
 *     summary: Remove um grupo
 *     tags: [Groups]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Grupo removido
 */
router.delete('/:id', requirePermission('groups'), remove);

export default router;




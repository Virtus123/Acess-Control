import express from 'express';
import * as accessRuleController from '../controllers/accessRuleController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AccessRules
 *   description: Regras de acesso e permissões por equipamento
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     AccessRule:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 */

// Todas as rotas precisam de autenticação
router.use(authenticate);

/**
 * @swagger
 * /access-rules:
 *   get:
 *     summary: Lista todas as regras de acesso
 *     tags: [AccessRules]
 *     responses:
 *       200:
 *         description: Lista de regras
 */
router.get('/', accessRuleController.list);

/**
 * @swagger
 * /access-rules/{id}:
 *   get:
 *     summary: Obtém detalhes de uma regra de acesso
 *     tags: [AccessRules]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados da regra
 */
router.get('/:id', accessRuleController.getById);

/**
 * @swagger
 * /access-rules:
 *   post:
 *     summary: Cria uma nova regra de acesso
 *     tags: [AccessRules]
 *     responses:
 *       201:
 *         description: Regra criada
 */
router.post('/', accessRuleController.create);

/**
 * @swagger
 * /access-rules/{id}:
 *   put:
 *     summary: Atualiza uma regra de acesso
 *     tags: [AccessRules]
 *     responses:
 *       200:
 *         description: Regra atualizada
 */
router.put('/:id', accessRuleController.update);

/**
 * @swagger
 * /access-rules/{id}:
 *   delete:
 *     summary: Remove uma regra de acesso
 *     tags: [AccessRules]
 *     responses:
 *       200:
 *         description: Regra removida
 */
router.delete('/:id', accessRuleController.remove);

export default router;

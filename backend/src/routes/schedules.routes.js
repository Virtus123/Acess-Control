import express from 'express';
import { list, getById, create, update, deleteSchedule } from '../controllers/scheduleController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Schedules
 *   description: Gerenciamento de horários e escalas de acesso
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Schedule:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 */

// All routes require authentication
router.use(authenticate);

// CRUD operations

/**
 * @swagger
 * /schedules:
 *   get:
 *     summary: Lista todos os horários cadastrados
 *     tags: [Schedules]
 *     responses:
 *       200:
 *         description: Lista de horários
 */
router.get('/', list);

/**
 * @swagger
 * /schedules/{id}:
 *   get:
 *     summary: Obtém detalhes de um horário
 *     tags: [Schedules]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados do horário
 */
router.get('/:id', getById);

/**
 * @swagger
 * /schedules:
 *   post:
 *     summary: Cria um novo horário/escala
 *     tags: [Schedules]
 *     responses:
 *       201:
 *         description: Horário criado
 */
router.post('/', create);

/**
 * @swagger
 * /schedules/{id}:
 *   put:
 *     summary: Atualiza um horário
 *     tags: [Schedules]
 *     responses:
 *       200:
 *         description: Horário atualizado
 */
router.put('/:id', update);

/**
 * @swagger
 * /schedules/{id}:
 *   delete:
 *     summary: Remove um horário
 *     tags: [Schedules]
 *     responses:
 *       200:
 *         description: Horário removido
 */
router.delete('/:id', deleteSchedule);

export default router;

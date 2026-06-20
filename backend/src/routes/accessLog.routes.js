import express from 'express';
import * as accessLogController from '../controllers/accessLogController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AccessLog
 *   description: Consulta de logs de acesso e eventos
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     AccessLog:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         time:
 *           type: string
 *           format: date-time
 *         event:
 *           type: integer
 *         device_id:
 *           type: integer
 *         person_id:
 *           type: string
 *         person_name:
 *           type: string
 *         person_type:
 *           type: string
 */

// Todas as rotas precisam de autenticação
router.use(authenticate);

/**
 * @swagger
 * /access-log/logs:
 *   get:
 *     summary: Lista os logs de acesso com filtros
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Lista de logs
 */
router.get('/logs', requirePermission('accessLog'), accessLogController.getAccessLogs);

/**
 * @swagger
 * /access-log/last:
 *   get:
 *     summary: Obtém o último evento de acesso registrado
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Último log
 */
router.get('/last', requirePermission('accessLog'), accessLogController.getLastAccess);

/**
 * @swagger
 * /access-log/stats:
 *   get:
 *     summary: Obtém estatísticas de acesso de hoje (Presentes, Entradas, Saídas)
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas de hoje
 */
router.get('/stats', requirePermission('accessLog'), accessLogController.getTodayStats);

/**
 * @swagger
 * /access-log/history/{personType}/{personId}:
 *   get:
 *     summary: Obtém o histórico de acessos de uma pessoa específica
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: personType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [person, visitor]
 *       - in: path
 *         name: personId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Histórico de acessos
 */
router.get('/history/:personType/:personId', requirePermission('accessLog'), accessLogController.getPersonAccessHistory);

/**
 * @swagger
 * /access-log/equipments:
 *   get:
 *     summary: Lista equipamentos que possuem logs
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de equipamentos
 */
router.get('/equipments', requirePermission('accessLog'), accessLogController.getEquipments);

/**
 * @swagger
 * /access-log/clear:
 *   delete:
 *     summary: Limpa os logs de acesso (Apenas Admin)
 *     tags: [AccessLog]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Logs limpos
 */
router.delete('/clear', accessLogController.clearAccessLogs);

export default router;

import express from 'express';
import accessTasksController from '../controllers/accessTasksController.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AccessTasks
 *   description: Comandos e tarefas para os equipamentos (Liberação remota, Sincronização)
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     AccessTask:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         command:
 *           type: string
 *         equip_id:
 *           type: string
 *         status:
 *           type: string
 */

// Routes for access tasks - Emergency Mode and Release Access

/**
 * @swagger
 * /access-tasks:
 *   post:
 *     summary: "Cria uma nova tarefa para um equipamento (Ex: Abrir porta remotamente)"
 *     tags: [AccessTasks]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tenant_id, equip_validator, task_type]
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 example: "123"
 *               equip_validator:
 *                 type: string
 *                 example: "C001"
 *               task_type:
 *                 type: string
 *                 enum: [emergencia, liberar_acesso, template_remote]
 *                 example: liberar_acesso
 *               person_id:
 *                 type: integer
 *               finger_type:
 *                 type: string
 *     responses:
 *       201:
 *         description: Tarefa enviada com sucesso
 */
router.post('/', accessTasksController.createTask);

/**
 * @swagger
 * /access-tasks:
 *   get:
 *     summary: Lista todas as tarefas (Fila de comandos)
 *     tags: [AccessTasks]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de tarefas retornada com sucesso
 */
router.get('/', accessTasksController.listTasks);

/**
 * @swagger
 * /access-tasks/status:
 *   get:
 *     summary: Obtém o status do modo de emergência
 *     tags: [AccessTasks]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Status retornado com sucesso
 */
router.get('/status', accessTasksController.getEmergencyStatus);

/**
 * @swagger
 * /access-tasks/poll:
 *   get:
 *     summary: Consulta tarefas pendentes (Usado pelo Comunicador)
 *     tags: [AccessTasks]
 *     parameters:
 *       - name: tenant_id
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de tarefas pendentes
 */
router.get('/poll', accessTasksController.getTasks);

/**
 * @swagger
 * /access-tasks/resolve:
 *   post:
 *     summary: Marca uma tarefa como resolvida/executada
 *     tags: [AccessTasks]
 *     parameters:
 *       - name: tenant_id
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tarefa resolvida
 */
router.post('/resolve', accessTasksController.resolveTask);

/**
 * @swagger
 * /access-tasks/clear:
 *   post:
 *     summary: Limpa a fila de tarefas pendentes
 *     tags: [AccessTasks]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Fila limpa com sucesso
 */
router.post('/clear', accessTasksController.clearQueue);

/**
 * @swagger
 * /access-tasks/sync-all:
 *   post:
 *     summary: Sincroniza todas as pessoas com os equipamentos
 *     tags: [AccessTasks]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Sincronização iniciada com sucesso
 */
router.post('/sync-all', accessTasksController.syncAllPersons);

// Lista equipamentos auditáveis
router.get('/auditable-equipments', accessTasksController.listAuditableEquipments);

// Disparo manual de auditoria
router.post('/trigger-audit', accessTasksController.triggerAudit);

// Status das tasks de auditoria (?ids=1,2,3)
router.get('/audit-status', accessTasksController.auditTaskStatus);

// Cancelar tasks de auditoria pendentes ({ ids: [1,2,3] })
router.post('/cancel-audit', accessTasksController.cancelAudit);

export default router;

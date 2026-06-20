import express from 'express';
import {
  list,
  getById,
  getByEquipId,
  create,
  update,
  remove,
  inactivate,
  activate,
  updateConnectionStatus,
  getByValidator,
  listByType,
  listParkingEquipments
} from '../controllers/equipmentController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';


const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Equipments
 *   description: Gerenciamento de equipamentos e dispositivos de acesso
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Equipment:
 *       type: object
 *       required:
 *         - name
 *         - ip
 *       properties:
 *         id:
 *           type: integer
 *         name:
 *           type: string
 *         ip:
 *           type: string
 *         equip_id:
 *           type: string
 *         type:
 *           type: string
 *         status:
 *           type: string
 *         last_seen:
 *           type: string
 *           format: date-time
 */

// ============================================
// ROTAS PÚBLICAS (para o Comunicador)
// ============================================

/**
 * @swagger
 * /equipments/sync/{equipId}:
 *   get:
 *     summary: Busca equipamento por equip_id (para sincronização do comunicador)
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: equipId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do equipamento
 */
router.get('/sync/:equipId', getByEquipId);

/**
 * @swagger
 * /equipments/validator/{validador}:
 *   get:
 *     summary: Buscar equipamento por validador (identificador do equipamento)
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: validador
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do equipamento
 */
router.get('/validator/:validador', getByValidator);

/**
 * @swagger
 * /equipments/connection/{equipId}:
 *   put:
 *     summary: Atualizar status de conexão do equipamento
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: equipId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Status atualizado
 */
router.put('/connection/:equipId', updateConnectionStatus);

/**
 * @swagger
 * /equipments/type/{tipo}:
 *   get:
 *     summary: Listar equipamentos por tipo (para sincronização do comunicador)
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: tipo
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de equipamentos
 */
router.get('/type/:tipo', listByType);

// ============================================
// ROTAS PROTEGIDAS (requerem autenticação)
// ============================================

router.use(authenticate);

/**
 * @swagger
 * /equipments:
 *   get:
 *     summary: Listar todos os equipamentos
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de equipamentos
 */
router.get('/', requirePermission('equipments'), list);

/**
 * @swagger
 * /equipments/parking:
 *   get:
 *     summary: Listar equipamentos que controlam estacionamento
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de equipamentos de estacionamento
 */
router.get('/parking', requirePermission('equipments'), listParkingEquipments);

/**
 * @swagger
 * /equipments/{id}:
 *   get:
 *     summary: Buscar equipamento por ID
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados do equipamento
 */
router.get('/:id', requirePermission('equipments'), getById);

/**
 * @swagger
 * /equipments:
 *   post:
 *     summary: Criar novo equipamento
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Equipment'
 *     responses:
 *       201:
 *         description: Equipamento criado
 */
router.post('/', requirePermission('equipments'), create);

/**
 * @swagger
 * /equipments/{id}:
 *   put:
 *     summary: Atualizar equipamento
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Equipamento atualizado
 */
router.put('/:id', requirePermission('equipments'), update);

/**
 * @swagger
 * /equipments/{id}:
 *   delete:
 *     summary: Exclui equipamento permanentemente (hard delete)
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Equipamento excluído
 */
router.delete('/:id', requirePermission('equipments'), remove);

/**
 * @swagger
 * /equipments/{id}/inactivate:
 *   post:
 *     summary: Inativar equipamento (soft delete)
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Equipamento inativado
 */
router.post('/:id/inactivate', requirePermission('equipments'), inactivate);

/**
 * @swagger
 * /equipments/{id}/activate:
 *   post:
 *     summary: Ativar equipamento
 *     tags: [Equipments]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Equipamento ativado
 */
router.post('/:id/activate', requirePermission('equipments'), activate);

export default router;

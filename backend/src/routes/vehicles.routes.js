import express from 'express';
import * as vehicleController from '../controllers/vehicleController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Vehicles
 *   description: Gerenciamento de veículos e controle de estacionamento
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Vehicle:
 *       type: object
 *       required:
 *         - plate
 *       properties:
 *         id:
 *           type: integer
 *         plate:
 *           type: string
 *         brand:
 *           type: string
 *         model:
 *           type: string
 *         color:
 *           type: string
 *         person_id:
 *           type: string
 *         visitor_id:
 *           type: string
 *         status:
 *           type: string
 *           enum: [in, out]
 */

// Todas as rotas precisam de autenticação
router.use(authenticate);

// Rotas de veículos - IN-PARKING ANTES DE /:id

/**
 * @swagger
 * /vehicles/in-parking:
 *   get:
 *     summary: Lista veículos que estão atualmente no estacionamento
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de veículos presentes
 */
router.get('/in-parking', vehicleController.getVehiclesInParking);

/**
 * @swagger
 * /vehicles/stats:
 *   get:
 *     summary: Obtém estatísticas do estacionamento (Vagas totais, ocupadas, livres)
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas do estacionamento
 */
router.get('/stats', vehicleController.getVehicleStats);

/**
 * @swagger
 * /vehicles:
 *   get:
 *     summary: Lista todos os veículos cadastrados
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Busca por placa, modelo ou dono
 *     responses:
 *       200:
 *         description: Lista de veículos
 */
router.get('/', vehicleController.list);

/**
 * @swagger
 * /vehicles/{id}:
 *   get:
 *     summary: Obtém detalhes de um veículo pelo ID
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dados do veículo
 */
router.get('/:id', vehicleController.getById);

/**
 * @swagger
 * /vehicles:
 *   post:
 *     summary: Cadastra um novo veículo
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Vehicle'
 *     responses:
 *       201:
 *         description: Veículo cadastrado
 */
router.post('/', vehicleController.create);

/**
 * @swagger
 * /vehicles/{id}:
 *   put:
 *     summary: Atualiza os dados de um veículo
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Veículo atualizado
 */
router.put('/:id', vehicleController.update);

/**
 * @swagger
 * /vehicles/{id}:
 *   delete:
 *     summary: Remove um veículo do cadastro
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Veículo removido
 */
router.delete('/:id', vehicleController.remove);

/**
 * @swagger
 * /vehicles/fix-import:
 *   post:
 *     summary: Corrige veículos importados sem marca (brand)
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Importação corrigida
 */
router.post('/fix-import', vehicleController.fixImportedVehicles);

/**
 * @swagger
 * /vehicles/manual-exit:
 *   post:
 *     summary: Registra a saída manual de um veículo (baixa no estacionamento)
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plate]
 *             properties:
 *               plate:
 *                 type: string
 *     responses:
 *       200:
 *         description: Saída registrada
 */
router.post('/manual-exit', vehicleController.registerManualExit);

/**
 * @swagger
 * /vehicles/manual-entry:
 *   post:
 *     summary: Registra a entrada manual de uma pessoa/veículo
 *     tags: [Vehicles]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Entrada registrada
 */
router.post('/manual-entry', vehicleController.registerManualEntry);

export default router;


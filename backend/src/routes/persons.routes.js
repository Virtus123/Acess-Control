import express from 'express';
import {
  list,
  getById,
  create,
  update,
  remove,
  activate,
  forceDelete,
  uploadPhoto,
  updateVehicle,
  getVehicle,
  getStats,
  generateRandomMatricula
} from '../controllers/personController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

import { upload } from '../config/upload.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Persons
 *   description: Gerenciamento de pessoas (funcionários, moradores, etc.)
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Person:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         registration_number:
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
 */

router.use(authenticate);

/**
 * @swagger
 * /persons:
 *   get:
 *     summary: Lista todas as pessoas
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Termo de busca (nome, cpf, matricula)
 *     responses:
 *       200:
 *         description: Lista de pessoas retornada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Person'
 */
router.get('/', requirePermission('persons'), list);

/**
 * @swagger
 * /persons/stats:
 *   get:
 *     summary: Obtém estatísticas de pessoas
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas retornadas com sucesso
 */
router.get('/stats', requirePermission('persons'), getStats);
router.get('/generate-registration', requirePermission('persons'), generateRandomMatricula);

/**
 * @swagger
 * /persons/{id}:
 *   get:
 *     summary: Obtém detalhes de uma pessoa pelo ID
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados da pessoa
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Person'
 */
router.get('/:id', requirePermission('persons'), getById);

/**
 * @swagger
 * /persons:
 *   post:
 *     summary: Cria uma nova pessoa
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Person'
 *     responses:
 *       201:
 *         description: Pessoa criada com sucesso
 */
router.post('/', requirePermission('persons'), create);

/**
 * @swagger
 * /persons/{id}:
 *   put:
 *     summary: Atualiza os dados de uma pessoa
 *     tags: [Persons]
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
 *             $ref: '#/components/schemas/Person'
 *     responses:
 *       200:
 *         description: Pessoa atualizada com sucesso
 */
router.put('/:id', requirePermission('persons'), update);

/**
 * @swagger
 * /persons/{id}:
 *   delete:
 *     summary: Remove uma pessoa (Soft Delete)
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pessoa removida com sucesso
 */
router.delete('/:id', requirePermission('persons'), remove);

/**
 * @swagger
 * /persons/{id}/activate:
 *   post:
 *     summary: Reativa uma pessoa (Muda status para active)
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pessoa reativada com sucesso
 */
router.post('/:id/activate', requirePermission('persons'), activate);

/**
 * @swagger
 * /persons/{id}/force:
 *   delete:
 *     summary: Exclui permanentemente uma pessoa do banco de dados
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Pessoa excluída permanentemente
 */
router.delete('/:id/force', requirePermission('persons'), forceDelete);

/**
 * @swagger
 * /persons/{id}/photo:
 *   post:
 *     summary: Faz o upload da foto de uma pessoa
 *     tags: [Persons]
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
router.post('/:id/photo', requirePermission('persons'), upload.single('photo'), uploadPhoto);

/**
 * @swagger
 * /persons/{id}/vehicle:
 *   get:
 *     summary: Obtém os dados do veículo vinculado à pessoa
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do veículo
 */
router.get('/:id/vehicle', requirePermission('persons'), getVehicle);

/**
 * @swagger
 * /persons/{id}/vehicle:
 *   post:
 *     summary: Atualiza ou vincula um veículo a uma pessoa
 *     tags: [Persons]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Veículo atualizado com sucesso
 */
router.post('/:id/vehicle', requirePermission('persons'), updateVehicle);

export default router;




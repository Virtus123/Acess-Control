import express from 'express';
import biometricController from '../controllers/biometricController.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Biometric
 *   description: Gerenciamento de templates biométricos e digitais
 */

// Public routes for communicator (no auth required)
// These routes receive biometric templates from equipment

/**
 * @swagger
 * /biometric/enroll/{tenant_id}/{person_id}:
 *   post:
 *     summary: Recebe um template biométrico de um equipamento (durante cadastro)
 *     tags: [Biometric]
 *     parameters:
 *       - in: path
 *         name: tenant_id
 *         required: true
 *       - in: path
 *         name: person_id
 *         required: true
 *     responses:
 *       200:
 *         description: Template recebido
 */
router.post('/enroll/:tenant_id/:person_id', biometricController.receiveTemplate);

/**
 * @swagger
 * /biometric/response/{tenant_id}/{person_id}:
 *   post:
 *     summary: Rota alternativa para recebimento de digital
 *     tags: [Biometric]
 *     responses:
 *       200:
 *         description: Template recebido
 */
router.post('/response/:tenant_id/:person_id', biometricController.receiveTemplate);

/**
 * @swagger
 * /biometric/status/{tenant_id}/{person_id}:
 *   get:
 *     summary: Consulta o status do cadastro biométrico (Polling do frontend)
 *     tags: [Biometric]
 *     responses:
 *       200:
 *         description: Status do cadastro
 */
router.get('/status/:tenant_id/:person_id', biometricController.getEnrollmentStatus);

/**
 * @swagger
 * /biometric/resolve/{tenant_id}/{person_id}:
 *   post:
 *     summary: Resolve a tarefa de cadastro após recebimento do template
 *     tags: [Biometric]
 *     responses:
 *       200:
 *         description: Tarefa resolvida
 */
router.post('/resolve/:tenant_id/:person_id', biometricController.resolveEnrollmentTask);

/**
 * @swagger
 * /biometric/identify/{tenant_id}:
 *   post:
 *     summary: Identifica uma pessoa pelo template biométrico (Match)
 *     tags: [Biometric]
 *     responses:
 *       200:
 *         description: Pessoa identificada
 */
router.post('/identify/:tenant_id', biometricController.identifyBiometric);

/**
 * @swagger
 * /biometric/identify-authorize/{tenant_id}:
 *   post:
 *     summary: Identifica e autoriza acesso por biometria
 *     tags: [Biometric]
 *     responses:
 *       200:
 *         description: Identificação e autorização concluídas
 */
router.post('/identify-authorize/:tenant_id', biometricController.identifyAndAuthorize);

export default router;

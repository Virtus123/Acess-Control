import express from 'express';
import {
  getLabels,
  updateLabels,
  getSystemConfig,
  updateSystemConfig,
  getLGPDConfig,
  getModules,
  updateModules,
  getReportCompany,
  updateReportCompany
} from '../controllers/configController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Config
 *   description: Configurações globais do sistema e personalização
 */

router.use(authenticate);

/**
 * @swagger
 * /config/labels:
 *   get:
 *     summary: Obtém as etiquetas customizadas do sistema
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Etiquetas retornadas
 */
router.get('/labels', getLabels);

/**
 * @swagger
 * /config/labels:
 *   put:
 *     summary: Atualiza as etiquetas customizadas (Apenas Admin)
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Etiquetas atualizadas
 */
router.put('/labels', requireRole('admin'), updateLabels);

/**
 * @swagger
 * /config/system:
 *   get:
 *     summary: Obtém a configuração geral do sistema
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Configuração retornada
 */
router.get('/system', requireRole('admin'), getSystemConfig);

/**
 * @swagger
 * /config/system:
 *   put:
 *     summary: Atualiza a configuração geral do sistema
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Configuração atualizada
 */
router.put('/system', requireRole('admin'), updateSystemConfig);

/**
 * @swagger
 * /config/modules:
 *   get:
 *     summary: Obtém os módulos ativos no sistema
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de módulos
 */
router.get('/modules', getModules);
router.put('/modules', requireRole('admin'), updateModules);

/**
 * @swagger
 * /config/report-company:
 *   get:
 *     summary: Obtém os dados da empresa para cabeçalho de relatórios
 *     tags: [Config]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Dados da empresa
 */
router.get('/report-company', getReportCompany);

export default router;

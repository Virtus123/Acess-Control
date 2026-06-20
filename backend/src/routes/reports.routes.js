import express from 'express';
import {
  getDashboard,
  createBackup,
  getBackups,
  getAccessReport,
  getAccessVehiclesReport,
  getVehicleAccessStats,
  getVehicleReportFilters,
  getPersonsReport,
  getVisitorsReport,
  getAccessStats,
  getReportFilters,
  getCompaniesReport,
  getVehiclesReport,
  getParkingsReport,
  getCafeteriasReport,
  getSchedulesReport,
  getKeyholdersReport
} from '../controllers/reportController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: Geração de relatórios e dashboards
 */

router.use(authenticate);

/**
 * @swagger
 * /reports/dashboard:
 *   get:
 *     summary: Obtém dados para o dashboard principal
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Dados do dashboard
 */
router.get('/dashboard', requirePermission('reports'), getDashboard);

/**
 * @swagger
 * /reports/access:
 *   get:
 *     summary: Relatório de acessos
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório gerado
 */
router.get('/access', requirePermission('reports'), getAccessReport);

/**
 * @swagger
 * /reports/access/vehicles:
 *   get:
 *     summary: Relatório de acessos de veículos
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório gerado
 */
router.get('/access/vehicles', requirePermission('reports'), getAccessVehiclesReport);

/**
 * @swagger
 * /reports/access/vehicles/stats:
 *   get:
 *     summary: Estatísticas de acesso de veículos
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas
 */
router.get('/access/vehicles/stats', requirePermission('reports'), getVehicleAccessStats);

/**
 * @swagger
 * /reports/access/stats:
 *   get:
 *     summary: Estatísticas gerais de acesso
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Estatísticas
 */
router.get('/access/stats', requirePermission('reports'), getAccessStats);

/**
 * @swagger
 * /reports/filters:
 *   get:
 *     summary: Filtros disponíveis para relatórios
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Filtros
 */
router.get('/filters', requirePermission('reports'), getReportFilters);

/**
 * @swagger
 * /reports/vehicles/filters:
 *   get:
 *     summary: Filtros específicos para veículos
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Filtros
 */
router.get('/vehicles/filters', requirePermission('reports'), getVehicleReportFilters);

/**
 * @swagger
 * /reports/persons:
 *   get:
 *     summary: Relatório de pessoas
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório
 */
router.get('/persons', requirePermission('reports'), getPersonsReport);

/**
 * @swagger
 * /reports/visitors:
 *   get:
 *     summary: Relatório de visitantes
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório
 */
router.get('/visitors', requirePermission('reports'), getVisitorsReport);

/**
 * @swagger
 * /reports/companies:
 *   get:
 *     summary: Relatório de empresas
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório
 */
router.get('/companies', requirePermission('reports'), getCompaniesReport);

/**
 * @swagger
 * /reports/vehicles:
 *   get:
 *     summary: Relatório de veículos
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Relatório
 */
router.get('/vehicles', requirePermission('reports'), getVehiclesReport);

/**
 * @swagger
 * /reports/backup:
 *   post:
 *     summary: Cria um backup do banco de dados (Apenas Admin)
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Backup criado
 */
router.post('/backup', requireRole('admin'), createBackup);

/**
 * @swagger
 * /reports/backups:
 *   get:
 *     summary: Lista backups disponíveis (Apenas Admin)
 *     tags: [Reports]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de backups
 */
router.get('/backups', requireRole('admin'), getBackups);

export default router;

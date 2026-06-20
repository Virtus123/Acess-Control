import express from 'express';
import * as tenantController from '../controllers/tenantController.js';
import * as vehicleController from '../controllers/vehicleController.js';
import revendasRoutes from './revendas.routes.js';
import billingRoutes from './billing.routes.js';
import { getStats, getHistory, forceSaveLog, getTenantStats, getRecentLogs, getSystemInfo } from '../controllers/monitorController.js';
import * as notificationController from '../controllers/notificationController.js';
import { getPriceTables, createPriceTable, updatePriceTable, deletePriceTable } from '../controllers/priceController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Aplicar autenticação a todas as rotas de admin
router.use(authenticate);
router.use(requireRole('admin', 'revenda'));

// Resetar estado do estacionamento
router.post('/reset-parking', vehicleController.resetParking);

// Criar novo tenant
router.post('/tenants', tenantController.createTenant);

// Listar todos os tenants
router.get('/tenants', tenantController.listTenants);

// Deletar tenant
router.delete('/tenants/:tenant_id', tenantController.deleteTenant);

// Editar tenant
router.patch('/tenants/:tenant_id', tenantController.editTenant);

// Resetar senha do admin do tenant
router.post('/tenants/:tenant_id/reset-password', tenantController.resetTenantPassword);

// Ativar/Desativar tenant
router.patch('/tenants/:tenant_id/toggle-status', tenantController.toggleTenantStatus);

// Entrar em um tenant como admin (impersonate)
router.post('/tenants/:tenant_id/impersonate', tenantController.impersonateTenant);

// Rotas de revenda (para admin revenda gerenciar suas bases)
router.use('/revenda', revendasRoutes);

// Rotas de faturamento (Admin Master)
router.use('/billing', billingRoutes);

// Rotas de monitoramento (Admin Master)
router.get('/monitoring/current', getStats);
router.get('/monitoring/history', getHistory);
router.post('/monitoring/force-save', forceSaveLog);
router.get('/monitoring/tenants', getTenantStats);
router.get('/monitoring/logs', getRecentLogs);
router.get('/monitoring/system', getSystemInfo);

// Rotas de notificações globais (Admin Master)
router.get('/notifications', notificationController.listAllNotifications);
router.post('/notifications', notificationController.createNotification);
router.put('/notifications/:id', notificationController.updateNotification);
router.delete('/notifications/:id', notificationController.deleteNotification);

// Rotas de tabelas de preços (Admin Master)
router.get('/prices', getPriceTables);
router.post('/prices', createPriceTable);
router.patch('/prices/:id', updatePriceTable);
router.delete('/prices/:id', deletePriceTable);

export default router;


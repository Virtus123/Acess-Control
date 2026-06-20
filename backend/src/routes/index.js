import express from 'express';
import { tenantMiddleware } from '../middleware/tenantManager.js';
import { rateLimiter, authLimiter } from '../config/security.js';
import { authenticate } from '../middleware/auth.js';
import dbManager from '../config/database.js';
import authRoutes from './auth.routes.js';
import personRoutes from './persons.routes.js';
import visitorRoutes from './visitors.routes.js';
import groupRoutes from './groups.routes.js';
import companyRoutes from './companies.routes.js';
import reportRoutes from './reports.routes.js';
import exportRoutes from './exports.routes.js';
import configRoutes from './config.routes.js';
import uploadRoutes from './upload.routes.js';
import adminRoutes from './admin.routes.js';
import parkingRoutes from './parkings.routes.js';
import holidayRoutes from './holidays.routes.js';
import scheduleRoutes from './schedules.routes.js';
import cafeteriaRoutes from './cafeterias.routes.js';
import keyholderRoutes from './keyholders.routes.js';
import faceRoutes from './face.routes.js';
import revendasRoutes from './revendas.routes.js';
import contatoRoutes from './contato.routes.js';
import passwordResetRoutes from './passwordReset.routes.js';
import pricesRoutes from './prices.routes.js';
import globalNotificationsRoutes from './notifications.routes.js';
import notificacoesRoutes from './notificacoes.js';
import refeitoriosRoutes from './refeitorios.routes.js';
import encomendasRoutes from './encomendas.routes.js';
import equipmentsRoutes from './equipments.routes.js';
import faceQueueRoutes from './faceQueue.routes.js';
import accessRulesRoutes from './accessRules.routes.js';
import autorizacaoRoutes from './autorizacao.routes.js';
import accessLogRoutes from './accessLog.routes.js';
import vehicleRoutes from './vehicles.routes.js';
import accessTasksRoutes from './accessTasks.routes.js';
import biometricRoutes from './biometric.routes.js';
import authorizationProfilesRoutes from './authorizationProfiles.routes.js';
import importRoutes from './import.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import comunicadorSyncRoutes from './comunicadorSync.routes.js';
import syncController from '../controllers/syncController.js';
import auditRoutes from './audit.routes.js';
import shiftNotesRoutes from './shiftNotes.routes.js';
import emailRoutes from './email.routes.js';
import reportJobsRoutes from './reportJobs.routes.js';
import { processarAcesso, healthCheck, confirmarAcesso } from '../controllers/autorizacaoController.js';
import { receiveUhfTag } from '../controllers/uhfController.js';
import { serveProtectedPhoto } from '../controllers/photoController.js';
import { comunicadorGetQueue, comunicadorMarkProcessed, comunicadorMarkError, comunicadorEquipmentStatus, comunicadorGetEquipments, comunicadorClearQueue } from '../controllers/faceQueueController.js';
import faceRemoteController from '../controllers/faceRemoteController.js';
import biometricController from '../controllers/biometricController.js';
import adminAuthRoutes from '../modules/admin/routes/adminAuth.routes.js';
import { publicRouter as publicPhotoPublic, adminRouter as publicPhotoAdmin } from './publicPhoto.routes.js';
import cors from 'cors';

const router = express.Router();

router.use(rateLimiter);

// ============================================
// ROTAS PÚBLICAS (sem autenticação)
// ============================================

// Health check (Auditoria SRE)
router.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0-hardened' 
  });
});

// Endpoint de manutenção para forçar recarregamento de conexões (sem autenticação)
router.get('/maintenance/reload-connections', async (req, res) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'X-Tenant-ID header required' });
    }
    
    console.log(`[Maintenance] Recarregando conexão para tenant: ${tenantId}`);
    
    // Fechar conexão existente para forçar recriação
    await dbManager.closeConnection(tenantId);
    
    // Obter nova conexão (isso vai verificar e adicionar a coluna se necessário)
    const newDb = await dbManager.getConnection(tenantId);
    
    console.log(`[Maintenance] Conexão recarregada para tenant: ${tenantId}`);
    
    res.json({ 
      success: true, 
      message: 'Conexão recarregada com sucesso',
      tenantId 
    });
  } catch (error) {
    console.error('[Maintenance] Erro ao recarregar conexão:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao recarregar conexão', 
      error: error.message 
    });
  }
});

// Rotas públicas do link de auto-cadastro de foto (sem tenantMiddleware)
// Token na URL resolve o tenant internamente.
router.use('/public-photo', publicPhotoPublic);

// Rotas públicas do Comunicador (sem tenantMiddleware)
router.get('/comunicador/queue', comunicadorGetQueue);
router.post('/comunicador/process', comunicadorMarkProcessed);
router.post('/comunicador/error', comunicadorMarkError);
router.post('/comunicador/equipment/status', comunicadorEquipmentStatus);
router.get('/comunicador/equipments', comunicadorGetEquipments);
router.delete('/comunicador/queue', comunicadorClearQueue);

// Rotas públicas de autorização (sem tenantMiddleware)
router.post('/autorizacao/access', processarAcesso);
router.post('/autorizacao/access/confirm', confirmarAcesso);
router.get('/autorizacao/status', healthCheck);

// Rotas públicas do Comunicador - Sync (Sincronização Sequencial)
router.use('/comunicador/sync', comunicadorSyncRoutes);

// Rota pública do Comunicador - Lista IDs de pessoas ativas (para limpeza de hardware)
router.get('/comunicador/persons', syncController.getActivePersonIds);

// Rotas públicas do Comunicador - Face Remote
router.post('/comunicador/face-remote/receive/:tenant_id/:task_id', faceRemoteController.receiveFacePhoto);
router.post('/comunicador/face-remote/error/:tenant_id/:task_id', faceRemoteController.reportFaceError);

// Rotas públicas do Comunicador - Tasks (poll e resolve)
import accessTasksController from '../controllers/accessTasksController.js';
router.get('/comunicador/tasks/poll', accessTasksController.getTasks);
router.post('/comunicador/tasks/resolve', accessTasksController.resolveTask);
router.post('/comunicador/tasks/audit-result', accessTasksController.auditResult);

// Rotas públicas do Comunicador - UHF (IDUHF)
router.post('/comunicador/uhf', receiveUhfTag);

// Rotas públicas do Comunicador - Biometric Enrollment
router.use('/comunicador/biometric', biometricRoutes);

// ============================================
// ROTAS PROTEGIDAS (requerem autenticação)
// ============================================

// Servir fotos descriptografadas publicamente (alias para comunicador e frontend)
router.get('/uploads/photos/:type/:filename', serveProtectedPhoto);

// Servir fotos protegidas/assinadas (legado)
router.get('/photos/:type/:filename', serveProtectedPhoto);

// Rotas de administração (MPanel)
const adminCors = cors({
  origin: [
    process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174',
    'https://example.com',
    'https://www.example.com',
    'http://localhost:5174',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID']
});

router.use('/admin', adminCors, adminAuthRoutes); // Login e Rotas Públicas Admin
router.use('/admin', adminCors, adminRoutes);     // Rotas Protegidas Admin

// Rota de revendas (sem tenantMiddleware para admin master)
router.use('/revendas', revendasRoutes);

// Rota de contato/suporte (sem tenantMiddleware)
router.use('/contato', contatoRoutes);

// Rota de recuperação de senha (precisa do tenant)
router.use('/password-reset', passwordResetRoutes);

// Rota de notificações globais (sem tenant)
router.use('/notifications', globalNotificationsRoutes);

// Rotas com tenant middleware (cliente)
router.use(tenantMiddleware);

router.use('/auth', authLimiter, authRoutes);
router.use('/persons', personRoutes);
router.use('/visitors', visitorRoutes);
router.use('/groups', groupRoutes);
router.use('/companies', companyRoutes);
router.use('/reports', reportRoutes);
router.use('/exports', exportRoutes);
router.use('/config', configRoutes);
router.use('/upload', uploadRoutes);
router.use('/parkings', parkingRoutes);
router.use('/holidays', holidayRoutes);
router.use('/schedules', scheduleRoutes);
router.use('/cafeterias', cafeteriaRoutes);
router.use('/keyholders', keyholderRoutes);
router.use('/face', faceRoutes);
router.use('/prices', pricesRoutes);
router.use('/refeitorios', refeitoriosRoutes);
router.use('/encomendas', encomendasRoutes);
router.use('/equipments', equipmentsRoutes);
router.use('/admin-photo-link', publicPhotoAdmin);
router.use('/face-queue', faceQueueRoutes);
router.use('/access-rules', accessRulesRoutes);
router.use('/autorizacao', autorizacaoRoutes);
router.use('/access-log', accessLogRoutes);
router.use('/vehicles', vehicleRoutes);
router.use('/access-tasks', accessTasksRoutes);
router.use('/authorization-profiles', authorizationProfilesRoutes);
router.use('/imports', importRoutes);
router.use('/audit', auditRoutes);
router.use('/shift-notes', shiftNotesRoutes);
router.use('/emails', emailRoutes);
router.use('/notificacoes', notificacoesRoutes);
router.use('/report-jobs', reportJobsRoutes);

// Push notification device registration (mobile app)
router.post('/notifications/register-device', authenticate, async (req, res) => {
  try {
    const { pushToken, platform, deviceName } = req.body;
    if (!pushToken) {
      return res.status(400).json({ success: false, message: 'pushToken is required' });
    }
    const db = req.db;
    await db.run(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        push_token TEXT UNIQUE NOT NULL,
        platform TEXT,
        device_name TEXT,
        user_id INTEGER,
        company_id INTEGER,
        tenant_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Garantir colunas tenant_id e company_id existam (migração segura)
    try { await db.run('ALTER TABLE push_devices ADD COLUMN tenant_id TEXT'); } catch (e) {}
    try { await db.run('ALTER TABLE push_devices ADD COLUMN company_id INTEGER'); } catch (e) {}

    await db.run(`
      INSERT INTO push_devices (push_token, platform, device_name, user_id, company_id, tenant_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(push_token) DO UPDATE SET
        platform = excluded.platform,
        device_name = excluded.device_name,
        user_id = excluded.user_id,
        company_id = excluded.company_id,
        tenant_id = excluded.tenant_id,
        updated_at = CURRENT_TIMESTAMP
    `, [
      pushToken,
      platform || 'unknown',
      deviceName || 'unknown',
      req.user?.id || null,
      req.user?.company_id || null,
      req.tenantId || null
    ]);
    res.json({ success: true, message: 'Device registered' });
  } catch (error) {
    console.error('Erro ao registrar push device:', error);
    res.status(500).json({ success: false, message: 'Error registering device' });
  }
});

// Rotas de biometria (protegidas)
router.get('/biometric/:tenant_id/:person_id', biometricController.getTemplates);
router.delete('/biometric/templates/:tenant_id/:template_id', biometricController.deleteTemplate);

// Rotas de cadastramento remoto de foto
router.use('/face-remote', faceRoutes);

router.use('/dashboard', dashboardRoutes);

export default router;




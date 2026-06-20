// Push Service — entry point
// Processo separado da API antiga. Roda na porta 3001.
// Não importa nada do backend antigo exceto autorizadorService.js (em onlineRoutes).

// Carrega .env (do backend/) se existir. Permite configurar PUSH_HOST, PUSH_PORT
// etc sem precisar setar variável de ambiente no shell.
import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from './infrastructure/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { initTenantManager } from './infrastructure/tenantDb.js';
import { runAllMigrations } from './infrastructure/migrations.js';
import { startOnlineMonitor } from './infrastructure/onlineMonitor.js';
import { startBridgeMonitor } from './infrastructure/bridgeMonitor.js';
import pushRoutes, { handleResult } from './interface/pushRoutes.js';
import onlineRoutes, { handleNewUserIdentified } from './interface/onlineRoutes.js';
import internalRoutes from './interface/internalRoutes.js';
import adminRoutes from './interface/adminRoutes.js';

const PORT = parseInt(process.env.PUSH_PORT || '3001', 10);
// Default 127.0.0.1 (produção, atrás de nginx). Para teste local com
// equipamento na LAN, setar PUSH_HOST=0.0.0.0
const HOST = process.env.PUSH_HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// === MIDDLEWARE GLOBAL DE LOG — captura TODAS as requests do equipamento ===
// Habilitado quando PUSH_DEBUG_INGRESS=1. Loga method, path, ip, query e content-length.
const DEBUG_INGRESS = process.env.PUSH_DEBUG_INGRESS === '1';
if (DEBUG_INGRESS) {
  app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().replace(/^::ffff:/, '');
    logger.info('ingress', {
      method: req.method,
      path: req.path,
      query: req.query,
      ip,
      contentLength: req.headers['content-length'] || 0,
      ua: req.headers['user-agent'] || '',
    });
    next();
  });
}

// === Heartbeat do equipamento — bate na RAIZ sem auth, exige 200 vazio ===
// Sem isso, a tela do Acess Control/painel marca equipamento como OFFLINE.
const aliveHandler = (req, res) => {
  logger.info('device_is_alive', {
    query: req.query,
    serial: req.query.serial,
    ip: req.ip?.replace(/^::ffff:/, ''),
  });
  res.status(200).send();
};
app.post('/device_is_alive.fcgi', aliveHandler);
app.post('/device_is_alive', aliveHandler);
app.get('/device_is_alive.fcgi', aliveHandler);
app.post('/api/device_is_alive.fcgi', aliveHandler);
app.post('/api/notifications/device_is_alive', aliveHandler);

// === Session valid (alguns firmwares perguntam antes de tudo) ===
const sessionValidHandler = (req, res) => {
  logger.debug('session_is_valid', { query: req.query });
  res.status(200).json({});
};
app.post('/session_is_valid.fcgi', sessionValidHandler);
app.post('/session_is_valid', sessionValidHandler);

// Health (público, sem auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'acess-push',
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Dashboard HTML estático em /admin/ui
app.use('/admin/ui', express.static(join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/admin/ui/'));

// Rotas principais
app.use('/api/push', pushRoutes);
app.use('/api/online', onlineRoutes);

// Firmware Control iD: dado push_remote_address = http://<host>/api,
// ela manda GET /api/push (pega comando) e POST /api/result (devolve resultado).
// NÃO /api/push/result. Esta rota é o que ela realmente bate.
app.post('/api/result', express.json({ limit: '10mb' }), express.urlencoded({ extended: true, limit: '10mb' }), handleResult);
app.use('/internal', internalRoutes);
app.use('/admin', adminRoutes);

// === Rotas que a FIRMWARE Control iD bate direto na raiz ===
// (configuradas via monitor.hostname/port + endpoints fixos da firmware)
const firmwareJson = express.json({ limit: '5mb' });
const firmwareUrl  = express.urlencoded({ extended: true, limit: '5mb' });
const firmwareRaw  = express.raw({ inflate: true, limit: '2mb', type: 'application/octet-stream' });

// Endpoint de identificação facial / cartão / senha — pede resposta síncrona
app.post('/new_user_identified.fcgi', firmwareJson, firmwareUrl, handleNewUserIdentified);
app.post('/new_card.fcgi', firmwareJson, firmwareUrl, handleNewUserIdentified);
app.post('/new_user_id_and_password.fcgi', firmwareJson, firmwareUrl, handleNewUserIdentified);

// === Cache de acessos pendentes (IDBlock Next em modo Push online) =========
// FLUXO:
//   1) Equip identifica → POST /new_user_identified → autorizador libera
//      catra both → onlineRoutes.handleNewUserIdentified guarda pending.
//   2) Pessoa gira a catraca → equip envia POST /api/notifications/catra_event
//      com direction (TURN LEFT/RIGHT), SEM user_id.
//   3) Recupera user_id pendente desse device, chama confirmarAcessoDirection
//      → mapeia direction (left/right) pra ENTRY/EXIT via equipment.direction_*
//      → grava no access_log.
//
// TTL 30s — se pessoa demorar pra girar, expira (próxima identificação reseta).
import {
  setAcessoPendente, popAcessoPendente,
} from './infrastructure/acessosPendentes.js';

app.post('/api/notifications/catra_event', firmwareJson, async (req, res) => {
  try {
    const { authenticateDevice } = await import('./infrastructure/deviceAuth.js');
    const auth = await authenticateDevice(req);
    if (!auth) return res.json({ status: 0 });

    const data = req.body || {};
    const deviceId = String(data.device_id || req.query.device_id || auth.deviceId);
    const evRaw = data.event;

    // event pode ser {name: "TURN LEFT"} ou int (FWs antigos)
    let direction = null;
    if (evRaw && typeof evRaw === 'object') {
      const name = (evRaw.name || '').toUpperCase();
      if (name === 'TURN LEFT') direction = 'left';
      else if (name === 'TURN RIGHT') direction = 'right';
      else if (name === 'GIVE UP') direction = 'giveup';
    }

    if (!direction) {
      logger.warn('catra_event_unknown', { deviceId, event: evRaw });
      return res.json({ status: 0 });
    }

    const userId = popAcessoPendente(auth.tenantId, deviceId);
    if (!userId) {
      logger.warn('catra_event_no_pending_user', { deviceId, direction });
      return res.json({ status: 0 });
    }

    try {
      const { confirmarAcessoDirection } = await import('../src/services/autorizadorService.js');
      const result = await confirmarAcessoDirection(auth.tenantId, deviceId, userId, direction);
      logger.info('catra_event_confirmed', {
        deviceId, userId, direction,
        allowed: result?.allowed, message: result?.message,
      });
    } catch (err) {
      logger.error('catra_event_confirm_failed', { deviceId, userId, direction, error: err.message });
    }
  } catch (err) {
    logger.error('catra_event_handler_failed', { error: err.message, stack: err.stack });
  }
  res.json({ status: 0 });
});

// Catch-all pra notificações novas — só loga pra observabilidade.
app.post('/api/notifications/:event', firmwareJson, firmwareRaw, (req, res) => {
  const event = req.params.event;
  // Não duplica log de eventos com handler dedicado
  if (['catra_event', 'device_is_alive'].includes(event)) {
    return res.json({});
  }
  const isBuf = Buffer.isBuffer(req.body);
  const bodyPreview = isBuf
    ? `<binary ${req.body.length}b>`
    : (() => { try { return JSON.stringify(req.body).slice(0, 300); } catch { return '<unparseable>'; } })();
  logger.info('notification_received', { event, query: req.query, body: bodyPreview });
  res.json({});
});

// Endpoints fixos da firmware que esperam só ACK (200 vazio)
app.post('/face_create.fcgi', firmwareJson, firmwareRaw, (req, res) => {
  logger.debug('face_create', { query: req.query, len: req.body?.length });
  res.send();
});

// 404
app.use((req, res) => {
  logger.warn('not_found', { method: req.method, path: req.path, query: req.query });
  res.status(404).json({ error: 'not_found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('unhandled_error', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ error: 'internal_error' });
});

async function start() {
  try {
    logger.info('starting');
    await initTenantManager();
    await runAllMigrations();
    logger.info('migrations_done');

    const server = app.listen(PORT, HOST, () => {
      logger.info('listening', { port: PORT, host: HOST });
      console.log(`✅ Push Service rodando em http://${HOST}:${PORT}`);
    });

    // Cron de status: zera equipments.online quando heartbeat para (>30s sem push_last_seen)
    startOnlineMonitor();
    // Cron de recovery: limpa equip_sync_queue órfãs e marca como dead tasks travadas
    startBridgeMonitor();

    // Long-poll precisa de timeout maior que 25s
    server.keepAliveTimeout = 40_000;
    server.headersTimeout = 45_000;
    server.requestTimeout = 0; // sem limite, controlamos via setTimeout no handler

    // Graceful shutdown
    const shutdown = (signal) => {
      logger.info('shutdown_signal', { signal });
      server.close(() => {
        logger.info('shutdown_complete');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000); // forçar saída se demorar
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
      logger.error('uncaughtException', { error: err.message, stack: err.stack });
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('unhandledRejection', { reason: String(reason) });
    });
  } catch (err) {
    logger.error('startup_failed', { error: err.message, stack: err.stack });
    console.error('❌ Falha ao iniciar:', err);
    process.exit(1);
  }
}

start();

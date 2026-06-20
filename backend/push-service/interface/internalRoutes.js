// Rotas internas (loopback) — só aceitas de 127.0.0.1.
// Usadas pelo backend antigo para acordar long-poll ou enfileirar comandos.

import express from 'express';
import { executeWake, executeEnqueue } from '../application/enqueueUseCase.js';
import { Command } from '../domain/command.js';
import logger from '../infrastructure/logger.js';
import { invalidateAuthCache } from '../infrastructure/deviceAuth.js';

const router = express.Router();
router.use(express.json({ limit: '5mb' }));

// Middleware: só aceita loopback
router.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    logger.warn('internal_blocked', { ip, path: req.path });
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// POST /internal/wake
// Body: { deviceId }
// Acorda long-poll daquele device (usado depois que backend antigo insere no outbox).
router.post('/wake', (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const { awoke } = executeWake(deviceId);
  logger.debug('wake_received', { deviceId, awoke });
  res.json({ awoke });
});

// POST /internal/enqueue
// Body: { tenantId, commands: [{ deviceId, endpoint, verb, body, ... }] }
// Alternativa ao wake: enfileira E acorda em uma chamada só.
router.post('/enqueue', async (req, res) => {
  try {
    const { tenantId, commands } = req.body || {};
    if (!tenantId || !Array.isArray(commands)) {
      return res.status(400).json({ error: 'tenantId and commands[] required' });
    }

    const cmdObjects = commands.map(c => new Command(c));
    const result = await executeEnqueue(tenantId, cmdObjects);

    res.json(result);
  } catch (err) {
    logger.error('internal_enqueue_failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /internal/invalidate-cache
// Body: { tenantId, deviceId? }
// Limpa caches em memória do Push (autorizador + auth de equipamento).
// Chamado pelo backend antigo quando regras/equipamentos mudam.
//
// Sem isso, Push e Backend ficam com caches divergentes (2 processos,
// 2 memórias). Equipamento que foi marcado como "saída" no backend continua
// sendo tratado como entrada pelo Push até o TTL expirar.
router.post('/invalidate-cache', async (req, res) => {
  const { tenantId, deviceId } = req.body || {};
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  // Cache do autorizador (regras + equipamentos + horários)
  try {
    const mod = await import('../../src/services/autorizadorService.js');
    if (mod.invalidateCache) mod.invalidateCache(tenantId);
  } catch (err) {
    logger.warn('invalidate_authorizer_failed', { error: err.message });
  }

  // Cache do resolver de regras de acesso (batch)
  try {
    const mod = await import('../../src/services/accessRuleResolver.js');
    if (mod.invalidate) mod.invalidate(tenantId);
  } catch (err) {
    logger.warn('invalidate_resolver_failed', { error: err.message });
  }

  // Cache de auth de equipamento (deviceAuth)
  if (deviceId) {
    invalidateAuthCache(deviceId);
  }

  logger.info('cache_invalidated', { tenantId, deviceId: deviceId || '(all)' });
  res.json({ ok: true });
});

export default router;

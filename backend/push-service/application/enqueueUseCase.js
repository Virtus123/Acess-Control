// Caso de uso: alguém (backend antigo, admin) quer enfileirar comando(s) e acordar long-poll.
// Usado tanto pelo /internal/wake quanto por qualquer ação administrativa.

import { enqueue } from '../infrastructure/outboxRepo.js';
import { wakeUp } from '../infrastructure/waiters.js';
import logger from '../infrastructure/logger.js';

/**
 * Recebe Commands prontos e enfileira. Acorda long-poll do device.
 * @param {string} tenantId
 * @param {Command[]} commands
 */
export async function executeEnqueue(tenantId, commands) {
  if (!commands || commands.length === 0) {
    return { enqueued: 0 };
  }

  const ids = await enqueue(tenantId, commands);

  // Agrupa por deviceId e acorda cada um
  const devices = new Set(commands.map(c => c.deviceId));
  for (const deviceId of devices) {
    wakeUp(deviceId);
  }

  logger.info('enqueued', {
    tenantId,
    count: ids.length,
    devices: Array.from(devices),
    origin: commands[0]?.origin,
  });

  return { enqueued: ids.length, ids };
}

/**
 * Atalho: só acorda long-poll sem enfileirar nada novo.
 * Usado pelo backend antigo após gravar no outbox diretamente.
 */
export function executeWake(deviceId) {
  const awoke = wakeUp(deviceId);
  return { awoke };
}

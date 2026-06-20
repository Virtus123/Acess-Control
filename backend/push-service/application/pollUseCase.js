// Caso de uso: equipamento chama GET /push pedindo comando.
// Orquestra: auth → circuit → repo → waiters.

import { pickPendingForDevice, touchDeviceLastSeen } from '../infrastructure/outboxRepo.js';
import { waitFor } from '../infrastructure/waiters.js';
import { isCircuitOpen } from '../infrastructure/circuitBreaker.js';
import { buildPushResponse } from '../domain/command.js';
import logger from '../infrastructure/logger.js';

const LONG_POLL_TIMEOUT_MS = parseInt(process.env.PUSH_LONG_POLL_MS || '25000', 10);

/**
 * @param {Object} auth - resultado de authenticateDevice
 * @param {string} uuid - uuid da transação (vem do equipamento)
 * @returns {Object|null} - payload pronto para JSON.stringify, ou null (resposta vazia)
 */
export async function executePoll(auth, uuid) {
  const { tenantId, deviceId } = auth;
  const t0 = Date.now();

  // Atualiza last_seen em background (não bloqueia)
  touchDeviceLastSeen(tenantId, deviceId).catch(err =>
    logger.warn('touch_last_seen_failed', { deviceId, error: err.message })
  );

  // Circuit aberto → resposta vazia (equipamento volta em push_request_period)
  if (isCircuitOpen(deviceId)) {
    logger.debug('poll_circuit_open', { deviceId });
    return null;
  }

  // Tentativa imediata
  let commands = await pickPendingForDevice(tenantId, deviceId, uuid);

  if (commands.length === 0) {
    // Long-poll: aguarda alguém chamar wakeUp
    const awoke = await waitFor(deviceId, LONG_POLL_TIMEOUT_MS);
    if (awoke) {
      // Acordado por novo comando enfileirado — tenta de novo
      commands = await pickPendingForDevice(tenantId, deviceId, uuid);
    }
  }

  const elapsed = Date.now() - t0;

  if (commands.length === 0) {
    logger.debug('poll_empty', { deviceId, elapsedMs: elapsed });
    return null;
  }

  logger.info('poll_delivered', {
    deviceId,
    tenantId,
    commandCount: commands.length,
    batchId: commands[0].batchId,
    uuid,
    elapsedMs: elapsed,
  });

  return buildPushResponse(commands);
}

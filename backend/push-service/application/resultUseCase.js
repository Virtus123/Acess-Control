// Caso de uso: equipamento devolve resultado via POST /push/result.
// Decide se foi sucesso ou erro, atualiza outbox, alimenta circuit breaker.

import { markCompleted, markFailed, markSkipped } from '../infrastructure/outboxRepo.js';
import { recordSuccess, recordFailure } from '../infrastructure/circuitBreaker.js';
import logger from '../infrastructure/logger.js';

/**
 * Classifica um erro retornado pelo equipamento em 3 categorias:
 *   - 'idempotent'         : já-aplicado (constraint duplicada). Trata como sucesso.
 *   - 'permanent_payload'  : payload inválido (foto pequena, formato errado, etc).
 *                            Skip permanente — retry vai falhar igual. NÃO conta no circuit.
 *   - 'transient'          : falha real de comunicação/equip. Conta no circuit + retry.
 */
function classifyError(respStr) {
  if (!respStr) return 'transient';
  const s = String(respStr).toLowerCase();

  if (/unique constraint|already exists|duplicate|constraint failed/.test(s)) {
    return 'idempotent';
  }

  // Erros de validação de payload que NUNCA vão dar certo num retry.
  // Adicionar padrões aqui quando descobrir novos casos.
  if (
    /image too short|image too small|image too large|image invalid|invalid image/.test(s)
    || /minimum size expected|maximum size/.test(s)
    || /value too long|invalid format|invalid value|out of range/.test(s)
    || /no such (column|table)/.test(s)
    || /unknown (object|field|parameter)/.test(s)
  ) {
    return 'permanent_payload';
  }

  return 'transient';
}

/**
 * @param {Object} auth
 * @param {Object} body - { deviceId, uuid, endpoint, response?, error?, transactions_results? }
 */
export async function executeResult(auth, body) {
  const { tenantId, deviceId } = auth;
  const { uuid, response, error, transactions_results } = body;

  if (!uuid) {
    logger.warn('result_no_uuid', { deviceId });
    return { ok: false, reason: 'uuid_required' };
  }

  // Caso 1: resposta de transactions (lote)
  if (Array.isArray(transactions_results)) {
    const failures = transactions_results.filter(r => r.success === false);
    // Classifica cada falha
    const classified = failures.map(r => ({
      ...r,
      kind: classifyError(JSON.stringify(r.response)),
    }));
    const transient = classified.filter(c => c.kind === 'transient');
    const permanent = classified.filter(c => c.kind === 'permanent_payload');

    if (transient.length > 0) {
      // Falha real de comunicação/equip — conta circuit + retry
      const errors = transient
        .map(r => `tx${r.transactionid}:${JSON.stringify(r.response)}`)
        .join('; ');
      await markFailed(tenantId, uuid, deviceId, errors);
      recordFailure(deviceId, errors);
      logger.warn('result_batch_failed', { deviceId, uuid, errors });
      return { ok: false, reason: 'batch_failed' };
    }

    if (permanent.length > 0) {
      // Erro permanente de payload (foto pequena, formato errado, etc).
      // Marca o batch como concluído (não vai retentar — vai falhar igual).
      // NÃO conta no circuit (não é problema de comunicação).
      // O sucesso do equip nessa rodada confirma que ele está OK.
      const errors = permanent
        .map(r => `tx${r.transactionid}:${JSON.stringify(r.response)}`)
        .join('; ');
      logger.warn('result_batch_permanent_skip', { deviceId, uuid, errors });
      await markSkipped(tenantId, uuid, deviceId, errors);
      recordSuccess(deviceId);  // equip está OK — payload é que estava ruim
      return { ok: true, reason: 'permanent_payload_skipped' };
    }

    // Só tinha duplicatas (ou nada falhou) → considera sucesso
    if (failures.length > 0) {
      logger.info('result_batch_ok_idempotent', {
        deviceId, uuid, total: transactions_results.length, idempotent: failures.length,
      });
    }
    await markCompleted(tenantId, uuid, deviceId, transactions_results);
    recordSuccess(deviceId);
    logger.info('result_batch_ok', { deviceId, uuid, count: transactions_results.length });
    return { ok: true };
  }

  // Caso 2: erro reportado pelo equipamento (comando único)
  if (error) {
    const kind = classifyError(error);
    if (kind === 'idempotent') {
      await markCompleted(tenantId, uuid, deviceId, { idempotent: true, error });
      recordSuccess(deviceId);
      logger.info('result_ok_idempotent', { deviceId, uuid, error });
      return { ok: true };
    }
    if (kind === 'permanent_payload') {
      await markSkipped(tenantId, uuid, deviceId, String(error));
      recordSuccess(deviceId);
      logger.warn('result_permanent_skip', { deviceId, uuid, error });
      return { ok: true, reason: 'permanent_payload_skipped' };
    }
    // transient
    await markFailed(tenantId, uuid, deviceId, String(error));
    recordFailure(deviceId, error);
    logger.warn('result_error', { deviceId, uuid, error });
    return { ok: false, reason: 'device_error' };
  }

  // Caso 3: sucesso simples
  await markCompleted(tenantId, uuid, deviceId, response);
  recordSuccess(deviceId);
  logger.info('result_ok', { deviceId, uuid });
  return { ok: true };
}

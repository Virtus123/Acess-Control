// Repositório de push_outbox — todas as queries ficam aqui.
// Não conhece HTTP, não conhece domínio. Só fala SQL.

import { getTenantDb } from './tenantDb.js';
import { Command } from '../domain/command.js';
import logger from './logger.js';

/**
 * Pega o próximo comando (ou batch) pendente para um device.
 * Se for batch (batch_id NOT NULL), retorna TODOS os irmãos do mesmo batch.
 * Marca picked_at no/nos retornados (UPDATE atômico).
 */
export async function pickPendingForDevice(tenantId, deviceId, uuid) {
  const db = await getTenantDb(tenantId);

  // Pega o primeiro pendente ordenado por (batch_id, batch_order, id)
  const first = await db.get(
    `SELECT * FROM push_outbox
     WHERE device_id = ? AND status = 'pending'
     ORDER BY id ASC LIMIT 1`,
    [deviceId]
  );

  if (!first) return [];

  // Se for batch, traz todos do mesmo batch_id (também pending)
  let rows;
  if (first.batch_id) {
    rows = await db.all(
      `SELECT * FROM push_outbox
       WHERE device_id = ? AND batch_id = ? AND status = 'pending'
       ORDER BY batch_order ASC, id ASC`,
      [deviceId, first.batch_id]
    );
  } else {
    rows = [first];
  }

  // Marca como in_flight (UPDATE em lote)
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await db.run(
    `UPDATE push_outbox
     SET status='in_flight', picked_at=datetime('now'), uuid=?, attempts=attempts+1
     WHERE id IN (${placeholders})`,
    [uuid, ...ids]
  );

  // Log evento "picked" pra cada linha
  for (const row of rows) {
    await db.run(
      `INSERT INTO push_outbox_log (outbox_id, device_id, event, uuid)
       VALUES (?, ?, 'picked', ?)`,
      [row.id, deviceId, uuid]
    );
  }

  return rows.map(r => Command.fromRow(r));
}

/**
 * Marca como done (sucesso).
 * Também faz a "ponte" para o modelo legado:
 *   - access_tasks com id em source_task_id → resolved=1
 *   - equip_sync_queue.id em source_sync_id → completed (quando o batch todo termina)
 */
export async function markCompleted(tenantId, uuid, deviceId, response) {
  const db = await getTenantDb(tenantId);
  const responseStr = typeof response === 'string'
    ? response
    : JSON.stringify(response);

  // Captura ANTES do update — depois do UPDATE perderíamos a info do batch.
  const beforeRows = await db.all(
    `SELECT id, source_task_id, source_sync_id, batch_id, picked_at
     FROM push_outbox WHERE uuid = ?`,
    [uuid]
  );

  const result = await db.run(
    `UPDATE push_outbox
     SET status='done', completed_at=datetime('now')
     WHERE uuid = ? AND status = 'in_flight'`,
    [uuid]
  );

  // Bridge 1: fecha access_tasks atreladas a esses comandos.
  const taskIds = [...new Set(beforeRows.map(r => r.source_task_id).filter(Boolean))];
  for (const taskId of taskIds) {
    try {
      await db.run(
        `UPDATE access_tasks
         SET resolved = 1, status = 'done', resolved_at = datetime('now')
         WHERE id = ? AND resolved = 0`,
        [taskId]
      );
    } catch (err) {
      logger.warn('bridge_task_close_failed', { tenantId, taskId, error: err.message });
    }
  }

  // Bridge 2: fecha equip_sync_queue SE for o último item do batch.
  // Um sync vira N rows em push_outbox com o mesmo source_sync_id (e geralmente
  // mesmo batch_id). Só fechamos o sync quando todos os irmãos estão done.
  const syncIds = [...new Set(beforeRows.map(r => r.source_sync_id).filter(Boolean))];
  for (const syncId of syncIds) {
    try {
      const pending = await db.get(
        `SELECT COUNT(*) AS c FROM push_outbox
         WHERE source_sync_id = ? AND status IN ('pending', 'in_flight')`,
        [syncId]
      );
      if (!pending || pending.c === 0) {
        await db.run(
          `UPDATE equip_sync_queue
           SET status = 'completed', completed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status IN ('pending', 'syncing')`,
          [syncId]
        );
        logger.info('bridge_sync_completed', { tenantId, syncId });
      }
    } catch (err) {
      logger.warn('bridge_sync_close_failed', { tenantId, syncId, error: err.message });
    }
  }

  // Duração + log de evento (usa primeira linha do batch)
  const first = beforeRows[0];
  if (first) {
    const startedAt = first.picked_at ? new Date(first.picked_at + 'Z').getTime() : Date.now();
    const durationMs = Date.now() - startedAt;
    await db.run(
      `INSERT INTO push_outbox_log (outbox_id, device_id, event, uuid, response, duration_ms)
       VALUES (?, ?, 'completed', ?, ?, ?)`,
      [first.id, deviceId, uuid, responseStr.slice(0, 2000), durationMs]
    );
  }

  return result.changes;
}

/**
 * Marca como 'skipped' — erro PERMANENTE de payload (foto inválida, formato
 * errado etc). Diferente de 'dead': não foi tentativa esgotada, foi erro que
 * sabemos que vai falhar igual em retry. Não bloqueia fila, não conta circuit.
 * Bridge fecha access_tasks correspondentes como 'skipped' (não 'failed').
 */
export async function markSkipped(tenantId, uuid, deviceId, errorText) {
  const db = await getTenantDb(tenantId);
  const errStr = String(errorText || 'unknown').slice(0, 1000);

  const rows = await db.all(
    `SELECT id, source_task_id FROM push_outbox WHERE uuid = ?`,
    [uuid]
  );

  for (const row of rows) {
    await db.run(
      `UPDATE push_outbox
       SET status='skipped', completed_at=datetime('now'), last_error=?
       WHERE id = ?`,
      [errStr, row.id]
    );
    await db.run(
      `INSERT INTO push_outbox_log (outbox_id, device_id, event, uuid, error)
       VALUES (?, ?, 'skipped', ?, ?)`,
      [row.id, deviceId, uuid, errStr]
    );

    // Bridge: fecha access_task como 'skipped'
    if (row.source_task_id) {
      try {
        await db.run(
          `UPDATE access_tasks
           SET resolved = 1, status = 'skipped', resolved_at = datetime('now'), error = ?
           WHERE id = ? AND resolved = 0`,
          [errStr, row.source_task_id]
        );
      } catch (err) {
        logger.warn('bridge_task_skip_failed', { tenantId, taskId: row.source_task_id, error: err.message });
      }
    }
  }

  return rows.length;
}

/**
 * Marca como erro. Se passou max_attempts, vira 'dead'. Senão, volta pra 'pending'.
 */
export async function markFailed(tenantId, uuid, deviceId, errorText) {
  const db = await getTenantDb(tenantId);
  const errStr = String(errorText || 'unknown').slice(0, 1000);

  const rows = await db.all(
    `SELECT id, attempts, max_attempts, source_task_id FROM push_outbox WHERE uuid = ?`,
    [uuid]
  );

  for (const row of rows) {
    const newStatus = row.attempts >= row.max_attempts ? 'dead' : 'pending';
    await db.run(
      `UPDATE push_outbox
       SET status = ?, last_error = ?, uuid = NULL
       WHERE id = ?`,
      [newStatus, errStr, row.id]
    );

    await db.run(
      `INSERT INTO push_outbox_log (outbox_id, device_id, event, uuid, error)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, deviceId, newStatus === 'dead' ? 'dead' : 'retry', uuid, errStr]
    );

    // Bridge: só fecha access_task como 'failed' quando esgotou os retries.
    // Enquanto 'retry', a task continua aberta — vai tentar de novo.
    if (newStatus === 'dead' && row.source_task_id) {
      try {
        await db.run(
          `UPDATE access_tasks
           SET resolved = 1, status = 'failed', resolved_at = datetime('now'), error = ?
           WHERE id = ? AND resolved = 0`,
          [errStr.slice(0, 500), row.source_task_id]
        );
      } catch (err) {
        logger.warn('bridge_task_fail_failed', { tenantId, taskId: row.source_task_id, error: err.message });
      }
    }
  }

  // Busca source_task_id/source_sync_id pra propagar bridge
  return rows.length;
}

/**
 * Insere comandos no outbox. Aceita 1 ou N (batch).
 * Recebe array de Commands. Devolve IDs gerados.
 */
export async function enqueue(tenantId, commands) {
  if (!commands || commands.length === 0) return [];
  const db = await getTenantDb(tenantId);
  const ids = [];

  for (const c of commands) {
    const bodyStr = c.body === null || c.body === undefined
      ? null
      : (typeof c.body === 'string' ? c.body : JSON.stringify(c.body));

    const result = await db.run(
      `INSERT INTO push_outbox
       (device_id, endpoint, verb, body, query_string, content_type,
        batch_id, batch_order, origin, source_task_id, source_sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.deviceId, c.endpoint, c.verb, bodyStr, c.queryString, c.contentType,
       c.batchId, c.batchOrder, c.origin, c.sourceTaskId || null, c.sourceSyncId || null]
    );
    ids.push(result.lastID);
  }

  return ids;
}

/**
 * Estatísticas por device (para /admin/devices).
 */
export async function getDeviceStats(tenantId, deviceId) {
  const db = await getTenantDb(tenantId);

  const counts = await db.all(
    `SELECT status, COUNT(*) AS c FROM push_outbox
     WHERE device_id = ? GROUP BY status`,
    [deviceId]
  );

  const lastError = await db.get(
    `SELECT last_error, attempts FROM push_outbox
     WHERE device_id = ? AND last_error IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [deviceId]
  );

  const stats = { pending: 0, in_flight: 0, done: 0, error: 0, dead: 0 };
  for (const row of counts) stats[row.status] = row.c;

  return { ...stats, lastError: lastError?.last_error || null };
}

/**
 * Limpeza periódica (chamar via cron diário). Remove 'done' mais antigos que N dias.
 */
export async function pruneCompleted(tenantId, olderThanDays = 7) {
  const db = await getTenantDb(tenantId);
  const result = await db.run(
    `DELETE FROM push_outbox
     WHERE status = 'done' AND completed_at < datetime('now', ?)`,
    [`-${olderThanDays} days`]
  );
  logger.info('prune_completed', { tenantId, removed: result.changes });
  return result.changes;
}

/**
 * Atualiza push_last_seen do equipamento e marca online=1.
 * `online` e `last_connection` são lidos pela UI legada (equipmentController).
 * Sem isso, equipamento aparece OFFLINE na tela do Acess Control mesmo bombando heartbeat.
 */
export async function touchDeviceLastSeen(tenantId, deviceId) {
  const db = await getTenantDb(tenantId);
  await db.run(
    `UPDATE equipments
     SET push_last_seen = datetime('now'),
         online = 1,
         last_connection = CURRENT_TIMESTAMP
     WHERE validador = ?`,
    [deviceId]
  );
}

/**
 * Marca como offline equipamentos push-enabled que pararam de bater heartbeat.
 * Chamado pelo cron em onlineMonitor.js — não é parte do hot path.
 */
export async function markStaleOffline(tenantId, staleSeconds = 30) {
  const db = await getTenantDb(tenantId);
  const result = await db.run(
    `UPDATE equipments
     SET online = 0
     WHERE push_enabled = 1
       AND online = 1
       AND (push_last_seen IS NULL OR push_last_seen < datetime('now', ?))`,
    [`-${staleSeconds} seconds`]
  );
  return result.changes;
}

// Cron de recovery: tira do limbo coisas que ficaram órfãs.
//
// Cenários que esta varredura corrige:
//  1. equip_sync_queue.status='syncing' de equip push-enabled travado por >5min
//     → marca como 'completed' (o Push assume o gerenciamento desses syncs).
//  2. equip_sync_queue.status='pending' de equip push-enabled SEM linhas no
//     push_outbox (= ninguém vai puxar essa fila) → 'completed' também.
//  3. access_tasks com source_task_id atrelado a push_outbox 'dead' →
//     fecha como 'failed' (defesa em profundidade, já feito no markFailed).

import { listTenants, getTenantDb } from './tenantDb.js';
import logger from './logger.js';

const INTERVAL_MS = parseInt(process.env.PUSH_BRIDGE_MONITOR_MS || '60000', 10);
const STUCK_SYNC_MINUTES = parseInt(process.env.PUSH_STUCK_SYNC_MIN || '5', 10);

const SYSTEM_TENANTS = new Set(['acesscontrolmaster']);

let timer = null;

async function sweepTenant(tenantId) {
  const db = await getTenantDb(tenantId);

  // 1. equip_sync_queue 'syncing' há mais de N minutos em equip push-enabled.
  //    Em modo push, sincronização é entrega de comandos pelo outbox — quando
  //    todo o batch fecha, a bridge no markCompleted marca como completed.
  //    Se ficou syncing >5min sem nada acontecer, é porque ou o batch já
  //    fechou e a bridge não rodou (caso edge), ou ninguém criou batch
  //    correspondente. De qualquer forma, libera a UI.
  try {
    const stuckSyncing = await db.run(
      `UPDATE equip_sync_queue
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE status = 'syncing'
         AND started_at < datetime('now', ?)
         AND equip_validator IN (
           SELECT validador FROM equipments WHERE push_enabled = 1
         )`,
      [`-${STUCK_SYNC_MINUTES} minutes`]
    );
    if (stuckSyncing.changes > 0) {
      logger.info('bridge_recovered_stuck_syncing', { tenantId, count: stuckSyncing.changes });
    }
  } catch (err) {
    if (!/no such (column|table)/i.test(err.message)) {
      logger.warn('bridge_sweep_syncing_failed', { tenantId, error: err.message });
    }
  }

  // 2. equip_sync_queue 'pending' de equip push-enabled SEM nada na push_outbox
  //    apontando pra ele (= sync sem comandos = órfão). Idem >5min de idade.
  try {
    const stuckPending = await db.run(
      `UPDATE equip_sync_queue
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE status = 'pending'
         AND created_at < datetime('now', ?)
         AND equip_validator IN (
           SELECT validador FROM equipments WHERE push_enabled = 1
         )
         AND id NOT IN (
           SELECT DISTINCT source_sync_id FROM push_outbox
           WHERE source_sync_id IS NOT NULL
         )`,
      [`-${STUCK_SYNC_MINUTES} minutes`]
    );
    if (stuckPending.changes > 0) {
      logger.info('bridge_recovered_orphan_pending', { tenantId, count: stuckPending.changes });
    }
  } catch (err) {
    if (!/no such (column|table)/i.test(err.message)) {
      logger.warn('bridge_sweep_pending_failed', { tenantId, error: err.message });
    }
  }
}

async function sweepOnce() {
  let tenants;
  try {
    tenants = await listTenants();
  } catch (err) {
    logger.warn('bridge_monitor_list_tenants_failed', { error: err.message });
    return;
  }
  for (const tenantId of tenants) {
    if (SYSTEM_TENANTS.has(tenantId)) continue;
    try {
      await sweepTenant(tenantId);
    } catch (err) {
      if (!/readonly|no such (column|table)/i.test(err.message)) {
        logger.warn('bridge_monitor_tenant_failed', { tenantId, error: err.message });
      }
    }
  }
}

export function startBridgeMonitor() {
  if (timer) return;
  logger.info('bridge_monitor_started', { intervalMs: INTERVAL_MS, stuckSyncMinutes: STUCK_SYNC_MINUTES });
  timer = setInterval(sweepOnce, INTERVAL_MS);
  timer.unref?.();
  sweepOnce().catch(() => {});
}

export function stopBridgeMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

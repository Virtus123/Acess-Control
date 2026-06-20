// Cron leve que zera equipments.online quando o heartbeat para.
// Sem isso, o equipamento fica eternamente "online" no banco se o Push cair
// no meio de uma sessão (o touchDeviceLastSeen nunca mais é chamado).
//
// Roda em todos os tenants abertos. Tenant fechado (sem requisição) não tem
// equipamento batendo heartbeat de qualquer forma, então não precisa varrer.

import { listTenants } from './tenantDb.js';
import { markStaleOffline } from './outboxRepo.js';
import logger from './logger.js';

const INTERVAL_MS = parseInt(process.env.PUSH_ONLINE_MONITOR_MS || '15000', 10);
const STALE_SECONDS = parseInt(process.env.PUSH_STALE_SECONDS || '30', 10);

// Tenants "do sistema" que não têm equipamentos push e por isso devem ser
// pulados nas varreduras (também são frequentemente read-only em produção).
const SYSTEM_TENANTS = new Set(['acesscontrolmaster']);

let timer = null;

async function sweepOnce() {
  let tenants;
  try {
    tenants = await listTenants();
  } catch (err) {
    logger.warn('online_monitor_list_tenants_failed', { error: err.message });
    return;
  }

  for (const tenantId of tenants) {
    if (SYSTEM_TENANTS.has(tenantId)) continue;  // master tenant não tem equips push
    try {
      const changed = await markStaleOffline(tenantId, STALE_SECONDS);
      if (changed > 0) {
        logger.info('online_monitor_marked_offline', { tenantId, count: changed });
      }
    } catch (err) {
      // Tenant pode não ter coluna push_enabled ainda — ignora silenciosamente.
      // Read-only db também ignora (tenants raros sem permissão de escrita).
      if (!/no such column|no such table|readonly/i.test(err.message)) {
        logger.warn('online_monitor_sweep_failed', { tenantId, error: err.message });
      }
    }
  }
}

export function startOnlineMonitor() {
  if (timer) return;
  logger.info('online_monitor_started', { intervalMs: INTERVAL_MS, staleSeconds: STALE_SECONDS });
  timer = setInterval(sweepOnce, INTERVAL_MS);
  timer.unref?.();
  sweepOnce().catch(() => {});
}

export function stopOnlineMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

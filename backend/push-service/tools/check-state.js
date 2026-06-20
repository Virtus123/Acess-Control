// Inspeciona estado atual de equipments/push_outbox/access_tasks/equip_sync_queue.
// Diagnóstico rápido — não modifica nada.

import { getTenantDb } from '../infrastructure/tenantDb.js';

const tenant = process.argv[2] || 'pushtest';
const db = await getTenantDb(tenant);

console.log(`\n=== tenant: ${tenant} ===\n`);

console.log('--- equipments ---');
const eqs = await db.all(
  `SELECT id, name, validador, active, status, push_enabled, online,
          push_last_seen, last_connection
   FROM equipments ORDER BY id`
);
for (const e of eqs) {
  console.log(`  id=${e.id} ${e.validador} [${e.name}] active=${e.active} status=${e.status} push_enabled=${e.push_enabled} online=${e.online}`);
  console.log(`     push_last_seen=${e.push_last_seen} last_connection=${e.last_connection}`);
}

console.log('\n--- push_outbox (últimas 15) ---');
const ob = await db.all(
  `SELECT id, device_id, endpoint, status, source_task_id, source_sync_id,
          origin, attempts, last_error, created_at
   FROM push_outbox ORDER BY id DESC LIMIT 15`
);
for (const r of ob) {
  console.log(`  #${r.id} dev=${r.device_id} ${r.endpoint} status=${r.status} origin=${r.origin || '-'} task=${r.source_task_id || '-'} sync=${r.source_sync_id || '-'} att=${r.attempts}`);
  if (r.last_error) console.log(`     ERR: ${r.last_error.slice(0,160)}`);
}

console.log('\n--- equip_sync_queue (últimas 10) ---');
const sq = await db.all(
  `SELECT id, equip_validator, status, created_at, started_at, completed_at
   FROM equip_sync_queue ORDER BY id DESC LIMIT 10`
);
for (const r of sq) {
  console.log(`  #${r.id} ${r.equip_validator} status=${r.status} created=${r.created_at} started=${r.started_at || '-'} done=${r.completed_at || '-'}`);
}

console.log('\n--- access_tasks (últimas 10) ---');
const at = await db.all(
  `SELECT id, task_type, equip_validator, resolved, status, target_type, target_id,
          created_at, resolved_at
   FROM access_tasks ORDER BY id DESC LIMIT 10`
);
for (const r of at) {
  console.log(`  #${r.id} ${r.task_type} ${r.equip_validator} resolved=${r.resolved} status=${r.status} target=${r.target_type}:${r.target_id} created=${r.created_at}`);
}

console.log('\n--- visitors ativos ---');
const vs = await db.all(
  `SELECT id, name, registration_number, status, updated_at FROM visitors ORDER BY id DESC LIMIT 10`
);
for (const v of vs) {
  console.log(`  #${v.id} ${v.name} reg=${v.registration_number || '-'} status=${v.status} updated=${v.updated_at}`);
}

process.exit(0);

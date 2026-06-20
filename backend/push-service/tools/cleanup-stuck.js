// Limpa órfãos do modelo legado pra equipamentos push-enabled:
//   - equip_sync_queue 'syncing'/'pending' que não vão completar (sem Comunicador rodando).
//   - access_tasks 'pending' de equipamentos push-enabled cujo source_task_id
//     correspondente já está done/dead/inexistente no push_outbox.
//
// Uso:
//   node push-service/tools/cleanup-stuck.js [tenant]   (default: pushtest)
//   node push-service/tools/cleanup-stuck.js --all      (varre todos os tenants)

import { listTenants, getTenantDb } from '../infrastructure/tenantDb.js';
import { runMigrationsForTenant } from '../infrastructure/migrations.js';

async function cleanupTenant(tenantId) {
  console.log(`\n=== tenant: ${tenantId} ===`);
  // Garante que ALTERs de source_task_id/source_sync_id já estão aplicados
  // (caso esse tenant nunca tenha aberto o Push após o patch).
  await runMigrationsForTenant(tenantId);
  const db = await getTenantDb(tenantId);

  // 1. equip_sync_queue: tudo 'syncing'/'pending' de equip push-enabled vira 'completed'
  try {
    const r1 = await db.run(
      `UPDATE equip_sync_queue
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE status IN ('syncing','pending')
         AND equip_validator IN (
           SELECT validador FROM equipments WHERE push_enabled = 1
         )`
    );
    console.log(`  equip_sync_queue: ${r1.changes} linhas → completed`);
  } catch (err) {
    console.log(`  equip_sync_queue: SKIP (${err.message})`);
  }

  // 2. access_tasks pending em equip push-enabled SEM contrapartida ativa
  //    no push_outbox → marca como cancelled (Comunicador legado não vai mais executá-las)
  try {
    const r2 = await db.run(
      `UPDATE access_tasks
       SET resolved = 1, status = 'cancelled', resolved_at = datetime('now')
       WHERE resolved = 0
         AND equip_validator IN (
           SELECT validador FROM equipments WHERE push_enabled = 1
         )
         AND id NOT IN (
           SELECT DISTINCT source_task_id FROM push_outbox
           WHERE source_task_id IS NOT NULL
             AND status IN ('pending','in_flight')
         )`
    );
    console.log(`  access_tasks: ${r2.changes} linhas órfãs → cancelled`);
  } catch (err) {
    console.log(`  access_tasks: SKIP (${err.message})`);
  }

  // 3. equipments offline esquecidos (sem push_last_seen e não bate há muito)
  //    SÓ informativo — o onlineMonitor.js cuida disso continuamente.
  try {
    const stillOnline = await db.all(
      `SELECT id, name, validador, online, push_last_seen
       FROM equipments WHERE push_enabled = 1`
    );
    console.log(`  equipments push-enabled: ${stillOnline.length}`);
    for (const e of stillOnline) {
      console.log(`    ${e.validador} [${e.name}] online=${e.online} push_last_seen=${e.push_last_seen || 'NUNCA'}`);
    }
  } catch (err) {
    console.log(`  equipments status: SKIP (${err.message})`);
  }
}

const arg = process.argv[2] || 'pushtest';

if (arg === '--all') {
  const tenants = await listTenants();
  for (const t of tenants) await cleanupTenant(t);
} else {
  await cleanupTenant(arg);
}

console.log('\n✅ cleanup concluído.');
process.exit(0);

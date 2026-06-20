// Reprocessa access_tasks 'delete_visitor' / 'delete_person' pending órfãs
// que foram criadas ANTES do plug do autorizador no push_outbox.
//
// Pra cada task pending desses tipos em equipamentos push-enabled, enfileira
// destroy_objects no push_outbox vinculado por source_task_id (bridge fecha
// automaticamente quando o equip confirmar).
//
// Uso: node push-service/tools/replay-delete-tasks.js [tenant]

import { getTenantDb } from '../infrastructure/tenantDb.js';
import { runMigrationsForTenant } from '../infrastructure/migrations.js';

const VISITOR_ID_OFFSET = 1_000_000_000;

// Replica simples da regra do toDeviceUserId — não importa do backend antigo
// pra script standalone não falhar se path quebrar.
function toDeviceUserId(type, internalId, registrationNumber) {
  if (registrationNumber !== null && registrationNumber !== undefined && registrationNumber !== '') {
    const onlyDigits = String(registrationNumber).replace(/\D/g, '');
    const matricula = parseInt(onlyDigits, 10);
    if (!Number.isNaN(matricula) && matricula > 0) return matricula;
  }
  const id = parseInt(internalId, 10);
  if (type === 'visitor') return id + VISITOR_ID_OFFSET;
  return id;
}

const tenant = process.argv[2] || 'pushtest';
await runMigrationsForTenant(tenant);
const db = await getTenantDb(tenant);

const tasks = await db.all(
  `SELECT id, task_type, target_type, target_id, equip_validator
   FROM access_tasks
   WHERE resolved = 0
     AND task_type IN ('delete_visitor', 'delete_person')`
);

console.log(`Tasks delete pending: ${tasks.length}`);

const pushDevices = await db.all(
  `SELECT validador FROM equipments WHERE active = 1 AND push_enabled = 1`
);
console.log(`Equipamentos push-enabled: ${pushDevices.length}`);

if (pushDevices.length === 0) {
  console.log('Nada a fazer (sem equip push).');
  process.exit(0);
}

let enqueued = 0;
for (const t of tasks) {
  // Resolve dados do alvo (matrícula pra equipUserId)
  const targetId = parseInt(t.target_id, 10);
  if (Number.isNaN(targetId)) {
    console.log(`  task #${t.id}: target_id inválido (${t.target_id}), pulando`);
    continue;
  }

  const table = t.task_type === 'delete_visitor' ? 'visitors' : 'persons';
  const row = await db.get(
    `SELECT registration_number FROM ${table} WHERE id = ?`,
    [targetId]
  );
  const reg = row?.registration_number;
  const kind = t.task_type === 'delete_visitor' ? 'visitor' : 'person';
  const equipUserId = toDeviceUserId(kind, targetId, reg);

  // Determina quais devices alvejar — 'all' = todos, ou validador específico
  const targets = t.equip_validator === 'all'
    ? pushDevices.map(d => d.validador)
    : [t.equip_validator];

  for (const deviceId of targets) {
    // Só enfileira se for um device push-enabled (nada feito pra Comunicador)
    if (!pushDevices.find(d => d.validador === deviceId)) continue;

    await db.run(
      `INSERT INTO push_outbox
       (device_id, endpoint, verb, body, content_type, origin, source_task_id)
       VALUES (?, ?, 'POST', ?, 'application/json', ?, ?)`,
      [
        deviceId,
        'destroy_objects',
        JSON.stringify({ object: 'users', where: { users: { id: equipUserId } } }),
        `replay:${kind}:delete:${targetId}`,
        t.id,
      ]
    );
    enqueued++;
    console.log(`  task #${t.id} → push_outbox destroy em ${deviceId} (equipUserId=${equipUserId})`);
  }
}

console.log(`\n✅ ${enqueued} commands enfileirados.`);
process.exit(0);

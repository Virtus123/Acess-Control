// Helper centralizado: sincroniza UM equipamento push-enabled.
// - resolve quem PODE estar nele (via accessRuleResolver)
// - enfileira destroy_objects users (wipe)
// - enfileira create_or_modify + user_groups + user_set_image dos autorizados
//
// Reusado por:
//   - accessTasksController.syncAllPersons (botão sincronizar)
//   - accessRuleController (regra mudou → resync dos equips afetados)
//   - groupController (grupo/membros mudou → resync)
//
// Cada comando carrega sourceSyncId pra bridge fechar equip_sync_queue
// automaticamente quando o último item terminar.

import { readFile } from 'fs/promises';
import { join } from 'path';
import { enqueuePushCommands, newBatchId } from './pushOutbox.js';
import { toDeviceUserId } from './deviceUserId.js';
import { getAuthorizedUsersForEquipment } from './accessRuleResolver.js';

async function loadPhotoBase64Soft(photoUrl) {
  if (!photoUrl) return null;
  try {
    const rel = photoUrl.replace(/^\//, '');
    for (const p of [
      join(process.cwd(), 'public', rel),
      join(process.cwd(), 'uploads', rel),
      join(process.cwd(), rel),
    ]) {
      try { return (await readFile(p)).toString('base64'); } catch {}
    }
  } catch {}
  return null;
}

/**
 * Sincroniza UM equipamento. Wipe + recreate só dos autorizados.
 *
 * @param {Object} db
 * @param {string} tenantId
 * @param {Object} equip - { id, validador }
 * @param {Object} options
 * @param {number|null} options.sourceSyncId  -- vincula commands a equip_sync_queue.id
 * @returns {Promise<{ enqueued: number, persons: number, visitors: number }>}
 */
export async function syncEquipmentPush(db, tenantId, equip, options = {}) {
  const { sourceSyncId = null } = options;
  const deviceId = equip.validador;

  // Resolve autorizados com cache bypass (queremos estado fresh)
  const { personIds, visitorIds } = await getAuthorizedUsersForEquipment(
    tenantId, equip.id, { bypassCache: true }
  );

  let persons = [];
  let visitors = [];
  if (personIds.size > 0) {
    const ph = Array.from(personIds).map(() => '?').join(',');
    persons = await db.all(
      `SELECT id, name, registration_number, photo_url FROM persons
       WHERE status = 'active' AND name IS NOT NULL AND id IN (${ph})`,
      Array.from(personIds)
    );
  }
  if (visitorIds.size > 0) {
    const ph = Array.from(visitorIds).map(() => '?').join(',');
    visitors = await db.all(
      `SELECT id, name, registration_number, photo_url FROM visitors
       WHERE status IN ('on_premises','pre-registered') AND name IS NOT NULL AND id IN (${ph})`,
      Array.from(visitorIds)
    );
  }

  let enqueued = 0;

  // 1) Wipe completo
  await enqueuePushCommands(db, [{
    deviceId,
    endpoint: 'destroy_objects',
    origin: 'rule_change:wipe',
    sourceSyncId,
    body: { object: 'users' },
  }]);
  enqueued++;

  // 2) Recreate autorizados
  const subjects = [
    ...persons.map(p => ({ ...p, kind: 'person' })),
    ...visitors.map(v => ({ ...v, kind: 'visitor' })),
  ];

  for (const s of subjects) {
    const origin = `rule_change:${s.kind}:${s.id}`;
    const equipUserId = toDeviceUserId(s.kind, s.id, s.registration_number);

    // BATCH 1: cadastro de user + grupo (rápido, sempre deve passar).
    // Foto vai em batch SEPARADO — se foto falhar (ex: muito pequena), user
    // continua cadastrado e libera acesso por reconhecimento manual/cartão.
    const registerBatchId = newBatchId();
    const registerCmds = [
      {
        deviceId, batchId: registerBatchId, batchOrder: 0, origin, sourceSyncId,
        endpoint: 'create_or_modify_objects',
        body: {
          object: 'users',
          values: [{
            id: equipUserId,
            registration: s.registration_number
              ? String(s.registration_number)
              : `${tenantId}_${s.kind[0]}${s.id}`,
            name: s.name,
          }],
        },
      },
      {
        deviceId, batchId: registerBatchId, batchOrder: 1, origin, sourceSyncId,
        endpoint: 'create_or_modify_objects',
        body: {
          object: 'user_groups',
          values: [{ user_id: equipUserId, group_id: 1 }],
        },
      },
    ];
    await enqueuePushCommands(db, registerCmds);
    enqueued += registerCmds.length;

    // BATCH 2: só a foto. Isolada. Falha de foto não derruba cadastro.
    const photo = await loadPhotoBase64Soft(s.photo_url);
    if (photo) {
      await enqueuePushCommands(db, [{
        deviceId, origin: `${origin}:photo`, sourceSyncId,
        endpoint: 'user_set_image',
        queryString: `user_id=${equipUserId}&timestamp=${Math.floor(Date.now()/1000)}&match=0`,
        body: photo,
        contentType: 'application/octet-stream',
      }]);
      enqueued++;
    }
  }

  return { enqueued, persons: persons.length, visitors: visitors.length };
}

/**
 * Dispara resync push em uma LISTA de equipamentos (por id).
 * Pra cada equip push-enabled:
 *   1. Cria/reaproveita equip_sync_queue ('syncing')
 *   2. Chama syncEquipmentPush com sourceSyncId
 *
 * Use após mutação que afeta autorização (regra editada, grupo mudou etc).
 */
export async function triggerResyncForEquipments(db, tenantId, equipmentIds) {
  if (!equipmentIds || equipmentIds.length === 0) return { equipments: 0, totalEnqueued: 0 };

  const ph = equipmentIds.map(() => '?').join(',');
  const equips = await db.all(
    `SELECT id, validador FROM equipments
     WHERE active = 1 AND push_enabled = 1 AND validador IS NOT NULL
       AND id IN (${ph})`,
    equipmentIds
  );

  let totalEnqueued = 0;
  const results = [];

  for (const e of equips) {
    // Reusa queue existente se já tem syncing pendente, ou cria nova
    const existing = await db.get(
      `SELECT id FROM equip_sync_queue
       WHERE equip_validator = ? AND status IN ('pending', 'syncing')`,
      [e.validador]
    );

    let syncId;
    if (existing) {
      syncId = existing.id;
    } else {
      const insert = await db.run(
        `INSERT INTO equip_sync_queue (tenant_id, equip_validator, status, started_at)
         VALUES (?, ?, 'syncing', CURRENT_TIMESTAMP)`,
        [tenantId, e.validador]
      );
      syncId = insert.lastID;
    }

    try {
      const r = await syncEquipmentPush(db, tenantId, e, { sourceSyncId: syncId });
      totalEnqueued += r.enqueued;
      results.push({ equipId: e.id, validador: e.validador, syncId, ...r });
    } catch (err) {
      console.error(`[triggerResync] equip ${e.validador} falhou:`, err.message);
    }
  }

  return { equipments: equips.length, totalEnqueued, results };
}

/**
 * Coleta equipamentos afetados por uma mudança de regra: união dos equipments
 * antigos e novos da regra. Útil pra resync após update/remove de regra.
 */
export function unionEquipmentIds(oldEquipIds, newEquipIds) {
  const set = new Set();
  for (const id of oldEquipIds || []) set.add(Number(id));
  for (const id of newEquipIds || []) set.add(Number(id));
  return Array.from(set).filter(n => !Number.isNaN(n));
}

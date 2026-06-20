// =============================================================================
// HELPER PARA O BACKEND ANTIGO — copiar para backend/src/services/pushOutbox.js
// =============================================================================
//
// Função única: enfileirar comando no push_outbox e acordar long-poll do device.
// Mantém retrocompatibilidade — se equipamento ainda usa Comunicador, este
// helper NÃO é chamado (o controller cai no else e usa face_queue como hoje).
//
// USO TÍPICO (em personController.js):
//
//   import { enqueueForActiveDevices } from '../services/pushOutbox.js';
//   import { translateRegisterPerson } from '../../../push-service/domain/commandTranslator.js';
//
//   // após INSERT da pessoa:
//   await enqueueForActiveDevices(req.db, req.tenantId, async (deviceId) => {
//     return translateRegisterPerson({
//       personId: person.id,
//       name: person.name,
//       tenantId: req.tenantId,
//       photoBase64: await loadPhotoBase64(person.photo_url),
//       deviceId,
//     });
//   });
// =============================================================================

import crypto from 'crypto';
import { isAuthorizedForEquipment } from './accessRuleResolver.js';

// Node 18+ tem fetch global — não precisa importar
const PUSH_SERVICE_URL = process.env.PUSH_SERVICE_URL || 'http://127.0.0.1:3001';

/**
 * Enfileira comandos no push_outbox via SQL direto (mesma conexão da request).
 * IMPORTANTE: chamar dentro da mesma "transação lógica" da operação principal.
 *
 * @param {Object} db - conexão dbAsync do tenant (req.db)
 * @param {Array<Object>} commandDescriptors - array de descritores
 *   Cada descritor: { deviceId, endpoint, verb, body, queryString, contentType, batchId, batchOrder, origin }
 * @returns {Promise<number[]>} - IDs gerados
 */
export async function enqueuePushCommands(db, commandDescriptors) {
  if (!commandDescriptors || commandDescriptors.length === 0) return [];

  const ids = [];
  for (const c of commandDescriptors) {
    const bodyStr = c.body === null || c.body === undefined
      ? null
      : (typeof c.body === 'string' ? c.body : JSON.stringify(c.body));

    const result = await db.run(
      `INSERT INTO push_outbox
       (device_id, endpoint, verb, body, query_string, content_type,
        batch_id, batch_order, origin, source_task_id, source_sync_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(c.deviceId),
        c.endpoint,
        c.verb || 'POST',
        bodyStr,
        c.queryString || null,
        c.contentType || 'application/json',
        c.batchId || null,
        c.batchOrder || 0,
        c.origin || null,
        c.sourceTaskId || null,
        c.sourceSyncId || null,
      ]
    );
    ids.push(result.lastID);
  }

  // Acorda long-poll do(s) device(s) — fire-and-forget
  const uniqueDevices = [...new Set(commandDescriptors.map(c => String(c.deviceId)))];
  for (const deviceId of uniqueDevices) {
    fetch(`${PUSH_SERVICE_URL}/internal/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    }).catch(() => { /* push service offline = sem problema, próximo poll pega */ });
  }

  return ids;
}

/**
 * Atalho: para cada equipamento ATIVO COM push_enabled=1 do tenant,
 * gera comandos via factory e enfileira. Equipamentos com push_enabled=0
 * são ignorados (continuam usando face_queue legado).
 *
 * @param {Object} db - req.db
 * @param {string} tenantId
 * @param {Function} commandFactory - async (deviceId) => Array<Object>
 */
export async function enqueueForActiveDevices(db, tenantId, commandFactory) {
  const devices = await db.all(
    `SELECT validador FROM equipments
     WHERE active = 1 AND push_enabled = 1 AND validador IS NOT NULL`
  );

  if (devices.length === 0) return { enqueued: 0, devices: 0 };

  const allCommands = [];
  for (const d of devices) {
    const cmds = await commandFactory(d.validador);
    if (Array.isArray(cmds)) allCommands.push(...cmds);
  }

  const ids = await enqueuePushCommands(db, allCommands);
  return { enqueued: ids.length, devices: devices.length, ids };
}

/**
 * Gera batchId compartilhado para um conjunto de comandos relacionados.
 */
export function newBatchId() {
  return crypto.randomUUID();
}

/**
 * Variante FILTRADA: para cada equip push-enabled, decide via accessRuleResolver
 * se a pessoa/visitante pode estar lá. Se SIM, enfileira `onAuthorized(deviceId)`.
 * Se NÃO, enfileira `onUnauthorized(deviceId)` (tipicamente um destroy_objects).
 *
 * Use isso em vez de `enqueueForActiveDevices` em create/update — garante que a
 * pessoa só fica no equip que ela tem permissão por regra de acesso.
 *
 * @param {Object} db
 * @param {string} tenantId
 * @param {'person'|'visitor'} type
 * @param {number} internalId  -- persons.id ou visitors.id
 * @param {Object} builders
 * @param {Function} builders.onAuthorized   async (deviceId) => Array<commandDescriptor>
 * @param {Function} builders.onUnauthorized async (deviceId) => Array<commandDescriptor>
 *                                            (opcional; default: nada)
 */
export async function enqueueForAuthorizedDevices(db, tenantId, type, internalId, builders) {
  const devices = await db.all(
    `SELECT id, validador FROM equipments
     WHERE active = 1 AND push_enabled = 1 AND validador IS NOT NULL`
  );

  if (devices.length === 0) return { enqueued: 0, authorized: 0, unauthorized: 0 };

  const allCommands = [];
  let authorized = 0;
  let unauthorized = 0;

  for (const d of devices) {
    let isAuthorized;
    try {
      isAuthorized = await isAuthorizedForEquipment(tenantId, d.id, type, internalId);
    } catch (err) {
      console.error('[enqueueForAuthorizedDevices] resolver falhou:', err.message);
      isAuthorized = false;
    }

    if (isAuthorized && builders.onAuthorized) {
      const cmds = await builders.onAuthorized(d.validador);
      if (Array.isArray(cmds)) allCommands.push(...cmds);
      authorized++;
    } else if (!isAuthorized && builders.onUnauthorized) {
      const cmds = await builders.onUnauthorized(d.validador);
      if (Array.isArray(cmds)) allCommands.push(...cmds);
      unauthorized++;
    }
  }

  const ids = await enqueuePushCommands(db, allCommands);
  return { enqueued: ids.length, authorized, unauthorized };
}

/**
 * Notifica o Push Service pra limpar caches em memória.
 * Necessário porque autorizador + resolver têm caches por processo, e
 * mudanças no banco (equipamento marcado como saída, regra criada etc)
 * só aparecem no Push depois desta chamada.
 *
 * Fire-and-forget: Push offline = sem problema, TTL eventual cuida.
 */
export function notifyPushInvalidateCache(tenantId, deviceId = null) {
  fetch(`${PUSH_SERVICE_URL}/internal/invalidate-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, deviceId }),
  }).catch(() => { /* Push offline = sem problema */ });
}

/**
 * Verifica se um equipamento específico está em modo push.
 * Útil para o controller decidir caminho push vs face_queue.
 */
export async function isDevicePushEnabled(db, deviceId) {
  const row = await db.get(
    `SELECT push_enabled FROM equipments WHERE validador = ?`,
    [deviceId]
  );
  return row?.push_enabled === 1;
}

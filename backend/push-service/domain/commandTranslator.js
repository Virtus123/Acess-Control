// Tradutor: ações de alto nível (semânticas do Acess Control) → comandos FCGI Control iD.
// Sem I/O. Pura função. Cada função devolve array de descritores que vira Command.
//
// REFERÊNCIA: PUSH.txt (raiz do Acess Control) + Postman collection.

import { Command } from './command.js';
import crypto from 'crypto';

/**
 * Cadastrar pessoa: cria user + adiciona ao grupo padrão + envia foto.
 * @param {Object} input - { personId, name, tenantId, photoBase64?, groupId? }
 * @returns {Command[]} — vão pra outbox como 1 batch (transactions)
 */
export function translateRegisterPerson({ personId, name, tenantId, photoBase64, groupId = 1, deviceId }) {
  if (!personId || !name || !tenantId || !deviceId) {
    throw new Error('translateRegisterPerson: faltam parâmetros obrigatórios');
  }

  const batchId = crypto.randomUUID();
  const origin = `person:create:${personId}`;
  const cmds = [];

  cmds.push(new Command({
    deviceId, batchId, batchOrder: 0, origin,
    endpoint: 'create_or_modify_objects',
    body: {
      object: 'users',
      values: [{
        id: personId,
        registration: `${tenantId}_${personId}`,
        name,
      }],
    },
  }));

  cmds.push(new Command({
    deviceId, batchId, batchOrder: 1, origin,
    endpoint: 'create_objects',
    body: {
      object: 'user_groups',
      values: [{ user_id: personId, group_id: groupId }],
    },
  }));

  if (photoBase64) {
    cmds.push(new Command({
      deviceId, batchId, batchOrder: 2, origin,
      endpoint: 'user_set_image',
      queryString: `user_id=${personId}&timestamp=${Math.floor(Date.now() / 1000)}&match=0`,
      body: photoBase64,
      contentType: 'application/octet-stream',
    }));
  }

  return cmds;
}

/**
 * Deletar pessoa (por ID ou por registration).
 */
export function translateDeletePerson({ personId, tenantId, deviceId }) {
  if (!personId || !deviceId) {
    throw new Error('translateDeletePerson: faltam parâmetros');
  }

  return [new Command({
    deviceId,
    origin: `person:delete:${personId}`,
    endpoint: 'destroy_objects',
    body: {
      object: 'users',
      where: { users: { id: parseInt(personId, 10) } },
    },
  })];
}

/**
 * Ativar/desativar modo emergência.
 */
export function translateEmergency({ enable, deviceId }) {
  if (!deviceId) throw new Error('translateEmergency: deviceId obrigatório');

  return [new Command({
    deviceId,
    origin: `emergency:${enable ? 'on' : 'off'}`,
    endpoint: 'set_configuration',
    body: {
      general: { exception_mode: enable ? 'emergency' : 'none' },
    },
  })];
}

/**
 * Liberar acesso uma vez. Tipo (catraca vs sec_box) depende do modelo.
 */
export function translateGrantAccess({ deviceId, modelo = 'iDFace' }) {
  if (!deviceId) throw new Error('translateGrantAccess: deviceId obrigatório');

  const isCatra = /idblock/i.test(modelo);
  const action = isCatra
    ? { action: 'catra', parameters: 'allow=both' }
    : { action: 'sec_box', parameters: 'id=65793,reason=3' };

  return [new Command({
    deviceId,
    origin: 'grant_access',
    endpoint: 'execute_actions',
    body: { actions: [action] },
  })];
}

/**
 * Abrir porta específica (iDBox/iDAccess).
 */
export function translateOpenDoor({ deviceId, doorNumber = 1 }) {
  return [new Command({
    deviceId,
    origin: `open_door:${doorNumber}`,
    endpoint: 'execute_actions',
    body: { actions: [{ action: 'door', parameters: `door=${doorNumber}` }] },
  })];
}

/**
 * Registrar cartão UHF (iDUHF).
 */
export function translateRegisterUhfCard({ deviceId, uhfTagInt, registrationNumber }) {
  if (!uhfTagInt || !registrationNumber) {
    throw new Error('translateRegisterUhfCard: faltam parâmetros');
  }
  return [new Command({
    deviceId,
    origin: `uhf:create:${uhfTagInt}`,
    endpoint: 'create_objects',
    body: {
      object: 'cards',
      values: [{ value: uhfTagInt, user_id: parseInt(registrationNumber, 10) }],
    },
  })];
}

/**
 * Remover cartão UHF.
 */
export function translateDeleteUhfCard({ deviceId, uhfTagInt }) {
  return [new Command({
    deviceId,
    origin: `uhf:delete:${uhfTagInt}`,
    endpoint: 'destroy_objects',
    body: {
      object: 'cards',
      where: { cards: { value: uhfTagInt } },
    },
  })];
}

/**
 * Limpar todos usuários (usado no full-sync, fase 1).
 */
export function translateClearAllUsers({ deviceId }) {
  return [new Command({
    deviceId,
    origin: 'full_sync:clear',
    endpoint: 'destroy_objects',
    body: { object: 'users' },
  })];
}

/**
 * Mensagem no display.
 */
export function translateMessageToScreen({ deviceId, message, timeout = 5000 }) {
  return [new Command({
    deviceId,
    origin: 'message',
    endpoint: 'message_to_screen',
    body: { message, timeout },
  })];
}

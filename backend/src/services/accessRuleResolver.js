// Access Rule Resolver
// =====================
// Calcula em BATCH "quem deveria estar cadastrado em cada equipamento"
// baseado nas regras de acesso, grupos e empresas.
//
// É o equivalente em-batch da lógica do autorizadorService.verificarAutorizacao,
// mas SEM o filtro de horário — equipamento mantém o cadastro o tempo todo,
// quem decide "naquele segundo se libera" é o autorizador online.
//
// CONVENÇÃO DE OR ENTRE REGRAS:
//   Se QUALQUER regra ativa cobre o (usuário × equipamento), está autorizado.
//   UNION dos conjuntos de cada regra que inclui esse equipamento.
//
// Visitantes:
//   - NÃO têm grupos nem empresas.
//   - Só recebem regras 'todos' ou 'visitantes-geral'.
//   - 'on_premises' e 'pre-registered' são considerados ativos.

import dbManager from '../config/database.js';

// ============================================
// CACHE
// ============================================

const CACHE_TTL_MS = 60 * 1000; // 60s — curto, igual lógica do autorizador
const cache = new Map(); // key: `${tenantId}:${equipmentId}` → { ts, personIds: Set, visitorIds: Set }

function cacheKey(tenantId, equipmentId) {
  return `${tenantId}:${equipmentId}`;
}

function cacheGet(tenantId, equipmentId) {
  const entry = cache.get(cacheKey(tenantId, equipmentId));
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(cacheKey(tenantId, equipmentId));
    return null;
  }
  return entry;
}

function cacheSet(tenantId, equipmentId, personIds, visitorIds) {
  cache.set(cacheKey(tenantId, equipmentId), {
    ts: Date.now(),
    personIds: new Set(personIds),
    visitorIds: new Set(visitorIds),
  });
}

/**
 * Invalida cache de TODO o tenant.
 * Chamar de access_rules/groups/companies/person_groups quando muda.
 */
export function invalidate(tenantId) {
  const prefix = `${tenantId}:`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/**
 * Invalida cache de um equipamento específico.
 * Útil quando uma regra é editada e a gente já sabe quais equips ela toca.
 */
export function invalidateEquipment(tenantId, equipmentId) {
  cache.delete(cacheKey(tenantId, equipmentId));
}

// ============================================
// HELPERS
// ============================================

function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value) || fallback; }
    catch { return fallback; }
  }
  return fallback;
}

async function fetchActiveRulesForEquipment(db, tenantId, equipmentId) {
  // Filtra no SQL com json_each pra evitar parsear todas as regras só pra descartar
  return db.all(
    `SELECT id, name, access_type, persons, companies, groups, equipments
     FROM access_rules
     WHERE tenant_id = ? AND active = 1
       AND EXISTS (
         SELECT 1 FROM json_each(access_rules.equipments)
         WHERE CAST(value AS INTEGER) = ?
       )`,
    [tenantId, equipmentId]
  );
}

// ============================================
// API PÚBLICA
// ============================================

/**
 * Retorna o conjunto de pessoas/visitantes autorizados naquele equipamento.
 * Resultado é UNION de todas as regras que incluem esse equipamento.
 *
 * @param {string} tenantId
 * @param {number} equipmentId  -- id de equipments.id (NÃO validador)
 * @param {Object} options
 * @param {boolean} options.bypassCache -- pula cache (use antes/depois de mutação pra diff)
 * @returns {Promise<{personIds: Set<number>, visitorIds: Set<number>}>}
 */
export async function getAuthorizedUsersForEquipment(tenantId, equipmentId, options = {}) {
  if (!options.bypassCache) {
    const cached = cacheGet(tenantId, equipmentId);
    if (cached) {
      return { personIds: new Set(cached.personIds), visitorIds: new Set(cached.visitorIds) };
    }
  }

  const db = await dbManager.getConnection(tenantId);
  const rules = await fetchActiveRulesForEquipment(db, tenantId, equipmentId);

  const personIds = new Set();
  const visitorIds = new Set();

  // Atalho: se alguma regra é 'todos', expande TUDO uma vez e sai.
  const hasTodos = rules.some(r => r.access_type === 'todos');
  if (hasTodos) {
    const allPersons = await db.all(`SELECT id FROM persons WHERE status = 'active'`);
    const allVisitors = await db.all(
      `SELECT id FROM visitors WHERE status IN ('on_premises', 'pre-registered')`
    );
    allPersons.forEach(p => personIds.add(p.id));
    allVisitors.forEach(v => visitorIds.add(v.id));
    cacheSet(tenantId, equipmentId, personIds, visitorIds);
    return { personIds, visitorIds };
  }

  for (const rule of rules) {
    const accessType = rule.access_type;

    if (accessType === 'pessoas-geral') {
      const rows = await db.all(`SELECT id FROM persons WHERE status = 'active'`);
      rows.forEach(r => personIds.add(r.id));

    } else if (accessType === 'visitantes-geral') {
      const rows = await db.all(
        `SELECT id FROM visitors WHERE status IN ('on_premises', 'pre-registered')`
      );
      rows.forEach(r => visitorIds.add(r.id));

    } else if (accessType === 'pessoas-especificas') {
      const ids = parseJson(rule.persons).map(Number).filter(n => !Number.isNaN(n));
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        const rows = await db.all(
          `SELECT id FROM persons WHERE status = 'active' AND id IN (${ph})`,
          ids
        );
        rows.forEach(r => personIds.add(r.id));
      }

    } else if (accessType === 'grupos') {
      const gids = parseJson(rule.groups).map(Number).filter(n => !Number.isNaN(n));
      if (gids.length > 0) {
        const ph = gids.map(() => '?').join(',');
        const rows = await db.all(
          `SELECT DISTINCT p.id FROM persons p
           LEFT JOIN person_groups pg ON pg.person_id = p.id
           WHERE p.status = 'active'
             AND (p.group_id IN (${ph}) OR pg.group_id IN (${ph}))`,
          [...gids, ...gids]
        );
        rows.forEach(r => personIds.add(r.id));
      }

    } else if (accessType === 'empresas') {
      const cids = parseJson(rule.companies).map(Number).filter(n => !Number.isNaN(n));
      if (cids.length > 0) {
        const ph = cids.map(() => '?').join(',');
        const rows = await db.all(
          `SELECT id FROM persons WHERE status = 'active' AND company_id IN (${ph})`,
          cids
        );
        rows.forEach(r => personIds.add(r.id));
      }
    }
    // outros access_type (futuros) caem no else implícito (não adiciona ninguém)
  }

  cacheSet(tenantId, equipmentId, personIds, visitorIds);
  return { personIds, visitorIds };
}

/**
 * Versão "ponto" — esta pessoa/visitante específica está autorizada nesse equip?
 * Otimizado pra plugs de create/update: só consulta o necessário.
 *
 * @param {string} tenantId
 * @param {number} equipmentId
 * @param {'person'|'visitor'} type
 * @param {number} internalId  -- persons.id ou visitors.id (não matrícula)
 * @returns {Promise<boolean>}
 */
export async function isAuthorizedForEquipment(tenantId, equipmentId, type, internalId) {
  const db = await dbManager.getConnection(tenantId);
  const rules = await fetchActiveRulesForEquipment(db, tenantId, equipmentId);

  if (rules.length === 0) return false;

  // Atalhos cheap-first: regras 'todos' resolvem na hora
  if (rules.some(r => r.access_type === 'todos')) {
    // Confere se a entidade existe E está ativa
    if (type === 'visitor') {
      const v = await db.get(
        `SELECT id FROM visitors WHERE id = ? AND status IN ('on_premises', 'pre-registered')`,
        [internalId]
      );
      return !!v;
    }
    const p = await db.get(`SELECT id FROM persons WHERE id = ? AND status = 'active'`, [internalId]);
    return !!p;
  }

  if (type === 'visitor') {
    // Visitante só passa se houver regra 'visitantes-geral' aplicável
    if (!rules.some(r => r.access_type === 'visitantes-geral')) return false;
    const v = await db.get(
      `SELECT id FROM visitors WHERE id = ? AND status IN ('on_premises', 'pre-registered')`,
      [internalId]
    );
    return !!v;
  }

  // Pessoa: verifica status + se alguma regra cobre
  const person = await db.get(
    `SELECT id, group_id, company_id FROM persons WHERE id = ? AND status = 'active'`,
    [internalId]
  );
  if (!person) return false;

  // 'pessoas-geral' cobre qualquer pessoa ativa
  if (rules.some(r => r.access_type === 'pessoas-geral')) return true;

  // Coleta grupos da pessoa (group_id + person_groups)
  let personGroups = null;
  async function getPersonGroups() {
    if (personGroups !== null) return personGroups;
    const extra = await db.all(`SELECT group_id FROM person_groups WHERE person_id = ?`, [internalId]);
    personGroups = new Set(extra.map(r => r.group_id));
    if (person.group_id) personGroups.add(person.group_id);
    return personGroups;
  }

  for (const rule of rules) {
    if (rule.access_type === 'pessoas-especificas') {
      const ids = parseJson(rule.persons).map(Number);
      if (ids.includes(internalId)) return true;
    } else if (rule.access_type === 'grupos') {
      const gids = parseJson(rule.groups).map(Number);
      if (gids.length === 0) continue;
      const pGroups = await getPersonGroups();
      if (gids.some(g => pGroups.has(g))) return true;
    } else if (rule.access_type === 'empresas') {
      if (!person.company_id) continue;
      const cids = parseJson(rule.companies).map(Number);
      if (cids.includes(person.company_id)) return true;
    }
  }

  return false;
}

/**
 * DIFF de autorização antes/depois de uma mutação (regra editada, grupo mudou, etc).
 * Recebe um snapshot ANTERIOR de autorizados, aplica a mutação (callback), tira novo
 * snapshot e enfileira:
 *   - quem ENTROU (estava out, agora in)  → buildCreateCommands(deviceId, type, id)
 *   - quem SAIU (estava in, agora out)    → buildDestroyCommands(deviceId, type, id)
 *
 * Use isso em: access_rules.update/create/delete, person_groups.add/remove,
 * companies.delete, groups.delete.
 *
 * @param {string} tenantId
 * @param {number[]} equipmentIds  -- equipamentos cujo diff queremos calcular
 * @param {Function} mutationFn    -- async () => void  (faz UPDATE/INSERT/DELETE no banco)
 * @param {Object} builders
 * @param {Function} builders.buildCreate   async (validador, type, internalId) => Array<cmd>
 * @param {Function} builders.buildDestroy  async (validador, type, internalId) => Array<cmd>
 * @returns {Promise<{equipmentDiffs: Array<{equipmentId, validador, added, removed}>}>}
 */
export async function recalcAndDiffEquipments(tenantId, equipmentIds, mutationFn, builders) {
  const db = await dbManager.getConnection(tenantId);

  // 1. Snapshot ANTES (bypass cache pra ler banco real)
  const before = new Map(); // equipId → { personIds: Set, visitorIds: Set, validador }
  for (const eid of equipmentIds) {
    const equip = await db.get(`SELECT validador FROM equipments WHERE id = ?`, [eid]);
    if (!equip || !equip.validador) continue;
    const snap = await getAuthorizedUsersForEquipment(tenantId, eid, { bypassCache: true });
    before.set(eid, { ...snap, validador: equip.validador });
  }

  // 2. Aplica a mutação
  await mutationFn();

  // 3. Invalida cache (regras/grupos podem ter mudado)
  invalidate(tenantId);

  // 4. Snapshot DEPOIS + diff + enfileira
  const { enqueuePushCommands } = await import('./pushOutbox.js');
  const diffs = [];

  for (const eid of equipmentIds) {
    const snapBefore = before.get(eid);
    if (!snapBefore) continue;
    const { validador } = snapBefore;

    const snapAfter = await getAuthorizedUsersForEquipment(tenantId, eid, { bypassCache: true });

    const addedP = setDiff(snapAfter.personIds, snapBefore.personIds);
    const removedP = setDiff(snapBefore.personIds, snapAfter.personIds);
    const addedV = setDiff(snapAfter.visitorIds, snapBefore.visitorIds);
    const removedV = setDiff(snapBefore.visitorIds, snapAfter.visitorIds);

    const commands = [];
    for (const pid of addedP) {
      const cmds = await builders.buildCreate(validador, 'person', pid);
      if (Array.isArray(cmds)) commands.push(...cmds);
    }
    for (const pid of removedP) {
      const cmds = await builders.buildDestroy(validador, 'person', pid);
      if (Array.isArray(cmds)) commands.push(...cmds);
    }
    for (const vid of addedV) {
      const cmds = await builders.buildCreate(validador, 'visitor', vid);
      if (Array.isArray(cmds)) commands.push(...cmds);
    }
    for (const vid of removedV) {
      const cmds = await builders.buildDestroy(validador, 'visitor', vid);
      if (Array.isArray(cmds)) commands.push(...cmds);
    }

    if (commands.length > 0) {
      await enqueuePushCommands(db, commands);
    }

    diffs.push({
      equipmentId: eid, validador,
      added: { persons: addedP.length, visitors: addedV.length },
      removed: { persons: removedP.length, visitors: removedV.length },
    });
  }

  return { equipmentDiffs: diffs };
}

function setDiff(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

/**
 * Lista equipamentos push-enabled de um tenant (helper pra plugs).
 * Retorna [{ id, validador, name, push_enabled }, ...].
 */
export async function listPushEnabledEquipments(tenantId) {
  const db = await dbManager.getConnection(tenantId);
  return db.all(
    `SELECT id, validador, name FROM equipments
     WHERE active = 1 AND push_enabled = 1 AND validador IS NOT NULL`
  );
}

/**
 * Debug — útil pro test-resolver. Retorna info expandida.
 */
export async function debugEquipment(tenantId, equipmentId) {
  const db = await dbManager.getConnection(tenantId);
  const equip = await db.get(`SELECT id, name, validador FROM equipments WHERE id = ?`, [equipmentId]);
  const rules = await fetchActiveRulesForEquipment(db, tenantId, equipmentId);
  const { personIds, visitorIds } = await getAuthorizedUsersForEquipment(
    tenantId, equipmentId, { bypassCache: true }
  );

  return {
    equipment: equip,
    rules: rules.map(r => ({
      id: r.id,
      name: r.name,
      access_type: r.access_type,
      persons: parseJson(r.persons),
      groups: parseJson(r.groups),
      companies: parseJson(r.companies),
    })),
    authorizedPersons: Array.from(personIds),
    authorizedVisitors: Array.from(visitorIds),
    totals: { persons: personIds.size, visitors: visitorIds.size },
  };
}

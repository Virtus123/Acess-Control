/**
 * Métricas de presença a partir de access_log (uma definição só no sistema).
 *
 * Presença: para cada (person_id + person_type), pega-se o último evento SUCCESS
 * entre ENTRY/EXIT (ordem: created_at DESC, id DESC). Está dentro se for ENTRY.
 */

const MOVEMENT_ACTIONS = `('ENTRY', 'EXIT')`;

function cteLastMovement(tenantParam = 'al.tenant_id = ?') {
  return `
    last_movement AS (
      SELECT
        al.person_id,
        al.person_type,
        al.action,
        ROW_NUMBER() OVER (
          PARTITION BY al.person_id, al.person_type
          ORDER BY al.created_at DESC, al.id DESC
        ) AS rn
      FROM access_log al
      WHERE ${tenantParam}
        AND al.status = 'SUCCESS'
        AND al.person_id IS NOT NULL
        AND al.person_type IS NOT NULL
        AND al.action IN ${MOVEMENT_ACTIONS}
    )
  `;
}

export async function countPresentPeople(db, tenantId) {
  const sql = `
    WITH ${cteLastMovement()}
    SELECT COUNT(*) AS count
    FROM last_movement
    WHERE rn = 1 AND action = 'ENTRY' AND person_type = 'person'
  `;
  const row = await db.get(sql, [tenantId]);
  return row?.count ?? 0;
}

export async function countPresentVisitors(db, tenantId) {
  const sql = `
    WITH ${cteLastMovement()}
    SELECT COUNT(*) AS count
    FROM last_movement
    WHERE rn = 1 AND action = 'ENTRY' AND person_type = 'visitor'
  `;
  const row = await db.get(sql, [tenantId]);
  return row?.count ?? 0;
}

/** Pessoas + visitantes no local (para cards que unificam "no prédio" sem veículo). */
export async function countPresentPersonsAndVisitors(db, tenantId) {
  const sql = `
    WITH ${cteLastMovement()}
    SELECT COUNT(*) AS count
    FROM last_movement
    WHERE rn = 1
      AND action = 'ENTRY'
      AND person_type IN ('person', 'visitor')
  `;
  const row = await db.get(sql, [tenantId]);
  return row?.count ?? 0;
}

/**
 * Veículos cadastrados (person_type = vehicle) no estacionamento.
 * person_id = id do registro em `vehicles`. Filtra contexto de garagem/placa como no dashboard.
 */
export async function countPresentRegisteredVehicles(db, tenantId) {
  const sql = `
    WITH ranked AS (
      SELECT
        al.action,
        ROW_NUMBER() OVER (
          PARTITION BY al.person_id
          ORDER BY al.created_at DESC, al.id DESC
        ) AS rn
      FROM access_log al
      LEFT JOIN equipments e ON al.equipment_id = e.id
      WHERE al.tenant_id = ?
        AND al.person_type = 'vehicle'
        AND al.status = 'SUCCESS'
        AND al.person_id IS NOT NULL
        AND al.action IN ${MOVEMENT_ACTIONS}
        AND (
          (al.plate IS NOT NULL AND TRIM(al.plate) != '')
          OR al.access_type = 'VEHICLE'
          OR e.controla_estacionamento = 1
          OR e.controla_estacionamento = true
        )
    )
    SELECT COUNT(*) AS count FROM ranked WHERE rn = 1 AND action = 'ENTRY'
  `;
  const row = await db.get(sql, [tenantId]);
  return row?.count ?? 0;
}

export default {
  countPresentPeople,
  countPresentVisitors,
  countPresentPersonsAndVisitors,
  countPresentRegisteredVehicles
};

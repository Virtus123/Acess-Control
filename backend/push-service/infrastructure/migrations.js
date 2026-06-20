// Migrações idempotentes — rodam toda vez que abre conexão de tenant.
// Cria tabelas push_outbox + push_outbox_log + colunas em equipments.
// Seguro rodar mil vezes (CREATE IF NOT EXISTS + ALTER em try/catch).

import { listTenants, getTenantDb } from './tenantDb.js';
import logger from './logger.js';

const SQL = {
  pushOutbox: `
    CREATE TABLE IF NOT EXISTS push_outbox (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id     TEXT NOT NULL,
      endpoint      TEXT NOT NULL,
      verb          TEXT NOT NULL DEFAULT 'POST',
      body          TEXT,
      query_string  TEXT,
      content_type  TEXT DEFAULT 'application/json',
      batch_id      TEXT,
      batch_order   INTEGER DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 5,
      last_error    TEXT,
      origin        TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      picked_at     DATETIME,
      completed_at  DATETIME,
      uuid          TEXT
    )
  `,
  pushOutboxLog: `
    CREATE TABLE IF NOT EXISTS push_outbox_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      outbox_id     INTEGER NOT NULL,
      device_id     TEXT NOT NULL,
      event         TEXT NOT NULL,
      uuid          TEXT,
      http_status   INTEGER,
      response      TEXT,
      error         TEXT,
      duration_ms   INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_push_outbox_pending
       ON push_outbox(device_id, status, batch_id, batch_order, id)`,
    `CREATE INDEX IF NOT EXISTS idx_push_outbox_uuid ON push_outbox(uuid)`,
    `CREATE INDEX IF NOT EXISTS idx_push_outbox_log_device
       ON push_outbox_log(device_id, created_at DESC)`,
  ],
  alterEquipments: [
    `ALTER TABLE equipments ADD COLUMN push_enabled INTEGER DEFAULT 0`,
    `ALTER TABLE equipments ADD COLUMN push_secret TEXT`,
    `ALTER TABLE equipments ADD COLUMN push_last_seen DATETIME`,
  ],
  // Bridge entre push_outbox e o modelo legado:
  //  - source_task_id  → access_tasks.id  (fecha a task quando o comando termina)
  //  - source_sync_id  → equip_sync_queue.id (fecha o sync quando o último item do batch fecha)
  alterPushOutbox: [
    `ALTER TABLE push_outbox ADD COLUMN source_task_id INTEGER`,
    `ALTER TABLE push_outbox ADD COLUMN source_sync_id INTEGER`,
  ],
};

export async function runMigrationsForTenant(tenantId) {
  const db = await getTenantDb(tenantId);

  await db.exec(SQL.pushOutbox);
  await db.exec(SQL.pushOutboxLog);

  for (const idx of SQL.indexes) {
    await db.exec(idx);
  }

  for (const alter of SQL.alterEquipments) {
    try { await db.exec(alter); }
    catch (err) {
      if (!/duplicate column/i.test(err.message)) {
        logger.warn('alter_failed', { tenantId, sql: alter, error: err.message });
      }
    }
  }

  for (const alter of SQL.alterPushOutbox) {
    try { await db.exec(alter); }
    catch (err) {
      if (!/duplicate column/i.test(err.message)) {
        logger.warn('alter_failed', { tenantId, sql: alter, error: err.message });
      }
    }
  }

  // Fix BUG legado: tenants antigos têm CHECK sem 'desativar_emergencia'.
  // Sem isso, frontend mostra "Nenhum equipamento respondeu" ao desativar.
  await fixAccessTasksConstraint(db, tenantId);
}

async function fixAccessTasksConstraint(db, tenantId) {
  try {
    const t = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='access_tasks'`);
    if (!t?.sql) return;
    if (t.sql.includes("'desativar_emergencia'")) return;

    logger.info('fix_access_tasks_constraint_start', { tenantId });
    const cols = (await db.all(`PRAGMA table_info('access_tasks')`)).map(c => c.name);

    await db.exec('PRAGMA foreign_keys=off');
    await db.exec('BEGIN TRANSACTION');
    try {
      await db.exec(`CREATE TABLE access_tasks_migrate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        equip_validator TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK(task_type IN (
          'emergencia','desativar_emergencia','liberar_acesso','template_remote',
          'delete_visitor','delete_person','sync_person',
          'face_remote','face_remote_capture'
        )),
        status INTEGER DEFAULT 1,
        resolved INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        resolved_by TEXT,
        person_id INTEGER,
        callback_url TEXT,
        finger_type TEXT,
        visitor_id INTEGER,
        person_type TEXT DEFAULT 'person',
        error TEXT,
        result_data TEXT,
        description TEXT,
        payload TEXT,
        target_type TEXT,
        target_id TEXT
      )`);

      const targetCols = ['id','tenant_id','equip_validator','task_type','status','resolved',
        'created_at','resolved_at','resolved_by','person_id','callback_url','finger_type',
        'visitor_id','person_type','error','result_data','description','payload',
        'target_type','target_id'];
      const insertCols = targetCols.filter(c => cols.includes(c));
      const selectExprs = insertCols.map(c => {
        if (c === 'task_type') {
          // Tolerante: task_types antigos/desconhecidos viram 'emergencia' (placeholder
          // seguro — task fica resolvida pelo legado se já estiver, ou pode ser
          // limpa pelo cleanup-stuck). Sem isso, CHECK constraint quebra a migration.
          return `CASE WHEN task_type IN (
            'emergencia','desativar_emergencia','liberar_acesso','template_remote',
            'delete_visitor','delete_person','sync_person',
            'face_remote','face_remote_capture'
          ) THEN task_type ELSE 'emergencia' END AS task_type`;
        }
        return c;
      }).join(', ');
      await db.exec(
        `INSERT INTO access_tasks_migrate (${insertCols.join(', ')}) ` +
        `SELECT ${selectExprs} FROM access_tasks`
      );

      await db.exec('DROP TABLE access_tasks');
      await db.exec('ALTER TABLE access_tasks_migrate RENAME TO access_tasks');

      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved)');

      await db.exec('COMMIT');
      logger.info('fix_access_tasks_constraint_done', { tenantId });
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await db.exec('PRAGMA foreign_keys=on');
    }
  } catch (err) {
    logger.warn('fix_access_tasks_constraint_failed', { tenantId, error: err.message });
  }
}

export async function runAllMigrations() {
  const tenants = await listTenants();
  logger.info('running_migrations', { count: tenants.length });
  for (const t of tenants) {
    try {
      await runMigrationsForTenant(t);
      logger.info('migration_ok', { tenantId: t });
    } catch (err) {
      logger.error('migration_failed', { tenantId: t, error: err.message });
    }
  }
}

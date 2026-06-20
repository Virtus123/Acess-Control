-- Migration 086: Adiciona coluna payload em access_tasks e remove CHECK constraint
-- para permitir novos task_types (register_uhf_card, delete_uhf_card) sem migrations futuras

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS access_tasks_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id        TEXT    NOT NULL,
    equip_validator  TEXT    NOT NULL,
    task_type        TEXT    NOT NULL,
    status           INTEGER DEFAULT 1,
    resolved         INTEGER DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at      DATETIME,
    resolved_by      TEXT,
    person_id        INTEGER,
    callback_url     TEXT,
    finger_type      TEXT,
    target_type      TEXT,
    target_id        TEXT,
    description      TEXT,
    payload          TEXT
);

INSERT INTO access_tasks_new (
    id, tenant_id, equip_validator, task_type, status, resolved,
    created_at, resolved_at, resolved_by, person_id, callback_url,
    finger_type, 
)
SELECT
    id, tenant_id, equip_validator, task_type, status, resolved,
    created_at, resolved_at, resolved_by, person_id, callback_url,
    finger_type, 
FROM access_tasks;

DROP TABLE access_tasks;
ALTER TABLE access_tasks_new RENAME TO access_tasks;

CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant    ON access_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);
CREATE INDEX IF NOT EXISTS idx_access_tasks_status    ON access_tasks(status, resolved);

COMMIT;

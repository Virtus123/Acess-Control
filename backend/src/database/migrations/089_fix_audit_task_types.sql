-- Migration: Expand access_tasks CHECK constraint to include audit task types
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS access_tasks_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    equip_validator TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('emergencia', 'desativar_emergencia', 'liberar_acesso', 'template_remote', 'audit_equipment', 'delete_person', 'delete_visitor')),
    status TEXT DEFAULT 'pending',
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
    payload TEXT
);

INSERT OR IGNORE INTO access_tasks_v3
    SELECT id, tenant_id, equip_validator, task_type,
        CASE WHEN typeof(status) = 'integer' OR (typeof(status) = 'text' AND status GLOB '[0-9]*')
             THEN 'pending' ELSE COALESCE(status, 'pending') END,
        resolved, created_at, resolved_at, resolved_by, person_id, callback_url, finger_type,
        visitor_id, person_type, error, result_data, description, payload
    FROM access_tasks
    WHERE task_type IN ('emergencia', 'desativar_emergencia', 'liberar_acesso', 'template_remote', 'audit_equipment', 'delete_person', 'delete_visitor');

DROP TABLE access_tasks;
ALTER TABLE access_tasks_v3 RENAME TO access_tasks;

CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);
CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved);

COMMIT;

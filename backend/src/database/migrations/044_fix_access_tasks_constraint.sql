-- Migration: Fix access_tasks CHECK constraint to allow template_remote
-- SQLite doesn't support ALTER TABLE for constraints, so we need to recreate the table

-- First, backup and recreate the table with the new constraint
BEGIN TRANSACTION;

-- Create temporary table with new schema
CREATE TABLE IF NOT EXISTS access_tasks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    equip_validator TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('emergencia', 'liberar_acesso', 'template_remote')),
    status INTEGER DEFAULT 1,
    resolved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    person_id INTEGER,
    callback_url TEXT,
    finger_type TEXT
);

-- Copy data from old table
INSERT INTO access_tasks_new (id, tenant_id, equip_validator, task_type, status, resolved, created_at, resolved_at, resolved_by)
SELECT id, tenant_id, equip_validator, task_type, status, resolved, created_at, resolved_at, resolved_by
FROM access_tasks;

-- Drop old table
DROP TABLE access_tasks;

-- Rename new table
ALTER TABLE access_tasks_new RENAME TO access_tasks;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);
CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved);

COMMIT;

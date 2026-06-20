-- Migration: Create access_tasks table for emergency and release access commands
-- This table stores tasks that equipment communicators will poll and execute

CREATE TABLE IF NOT EXISTS access_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    equip_validator TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK(task_type IN ('emergencia', 'liberar_acesso')),
    status INTEGER DEFAULT 1, -- 1 = active, 0 = inactive (for emergency mode toggle)
    resolved INTEGER DEFAULT 0, -- 0 = pending, 1 = resolved/completed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    person_id INTEGER,
    callback_url TEXT,
    finger_type TEXT,
    target_type TEXT,
    target_id TEXT,
    description TEXT,
    payload TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);
CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved);

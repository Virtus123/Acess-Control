-- Migration 018: Remove foreign keys referencing non-existent tenants table
-- The tenants table doesn't exist in individual tenant databases

-- Recreate holidays table without foreign key
CREATE TABLE IF NOT EXISTS holidays_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT DEFAULT 'national',
    description TEXT,
    repeat_annual INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

-- Copy data from old table
INSERT INTO holidays_new (id, tenant_id, name, date, type, description, created_at, updated_at)
SELECT id, tenant_id, name, date, type, description, created_at, updated_at FROM holidays;

-- Drop old table
DROP TABLE holidays;

-- Rename new table
ALTER TABLE holidays_new RENAME TO holidays;

-- Recreate schedules table without foreign key
CREATE TABLE IF NOT EXISTS schedules_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

INSERT INTO schedules_new (id, tenant_id, name, type, description, created_at, updated_at)
SELECT id, tenant_id, name, type, description, created_at, updated_at FROM schedules;

DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;

-- Recreate cafeterias table without foreign key
CREATE TABLE IF NOT EXISTS cafeterias_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    location TEXT,
    capacity INTEGER,
    schedule_id INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

INSERT INTO cafeterias_new (id, tenant_id, name, location, capacity, schedule_id, active, created_at, updated_at)
SELECT id, tenant_id, name, location, capacity, schedule_id, active, created_at, updated_at FROM cafeterias;

DROP TABLE cafeterias;
ALTER TABLE cafeterias_new RENAME TO cafeterias;

-- Recreate keyholders table without foreign key
CREATE TABLE IF NOT EXISTS keyholders_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    location TEXT,
    capacity INTEGER,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
);

INSERT INTO keyholders_new (id, tenant_id, name, location, capacity, description, active, created_at, updated_at)
SELECT id, tenant_id, name, location, capacity, description, active, created_at, updated_at FROM keyholders;

DROP TABLE keyholders;
ALTER TABLE keyholders_new RENAME TO keyholders;

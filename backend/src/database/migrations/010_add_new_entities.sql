-- Migration: Add new entities tables (holidays, schedules, cafeterias, keyholders)
-- Created: 2026-02-03

-- Create holidays table
CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    type TEXT DEFAULT 'national',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Create indexes for holidays
CREATE INDEX IF NOT EXISTS idx_holidays_tenant ON holidays(tenant_id);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);

-- Create schedules table
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Create schedule_ranges table
CREATE TABLE IF NOT EXISTS schedule_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);

-- Create indexes for schedules
CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);

-- Create cafeterias table
CREATE TABLE IF NOT EXISTS cafeterias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    location TEXT,
    capacity INTEGER,
    schedule_id INTEGER,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);

-- Create indexes for cafeterias
CREATE INDEX IF NOT EXISTS idx_cafeterias_tenant ON cafeterias(tenant_id);

-- Create keyholders table
CREATE TABLE IF NOT EXISTS keyholders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    location TEXT,
    capacity INTEGER,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Create indexes for keyholders
CREATE INDEX IF NOT EXISTS idx_keyholders_tenant ON keyholders(tenant_id);

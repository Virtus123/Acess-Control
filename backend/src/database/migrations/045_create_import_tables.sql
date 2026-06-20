-- Migration: Create tables for import functionality
-- Tables: imports, import_errors

-- Table to track import jobs
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('person', 'visitor')),
    import_with_photo INTEGER DEFAULT 0,
    import_as_inactive INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    processed INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'finished', 'failed')),
    file_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    finished_at DATETIME
);

-- Table to track import errors
CREATE TABLE IF NOT EXISTS import_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    line_number INTEGER,
    message TEXT,
    raw_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_id) REFERENCES imports(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_imports_tenant ON imports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_imports_status ON imports(status);
CREATE INDEX IF NOT EXISTS idx_import_errors_import ON import_errors(import_id);

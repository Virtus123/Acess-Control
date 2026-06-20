-- Update visitors status CHECK constraint to allow 'pre-registered'
-- SQLite requires table re-creation to update CHECK constraints

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- 1. Create temporary backup
CREATE TABLE visitors_backup AS SELECT * FROM visitors;

-- 2. Drop current table
DROP TABLE visitors;

-- 3. Create new table with updated CHECK constraint
CREATE TABLE visitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT,
    name TEXT NOT NULL,
    document TEXT,
    rg TEXT,
    cellphone TEXT,
    email TEXT,
    visitor_company TEXT,
    visited_person_id INTEGER,
    visited_company_id INTEGER,
    reason TEXT,
    entry_date DATETIME,
    exit_date DATETIME,
    photo_url TEXT,
    status TEXT DEFAULT 'on_premises' CHECK(status IN ('on_premises', 'exited', 'inactive', 'pre-registered')),
    registered_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    registration_number TEXT,
    prevent_auto_exit INTEGER DEFAULT 0,
    liberation_type TEXT DEFAULT 'unica',
    period_start DATETIME,
    period_end DATETIME,
    expected_exit_date DATETIME,
    face_embedding TEXT,
    card_number TEXT,
    card_type TEXT DEFAULT 'manual',
    photo_base64 TEXT,
    FOREIGN KEY (visited_person_id) REFERENCES persons(id),
    FOREIGN KEY (visited_company_id) REFERENCES companies(id),
    FOREIGN KEY (registered_by) REFERENCES users(id)
);

-- 4. Restore data
INSERT INTO visitors (
    id, tenant_id, name, document, rg, cellphone, email, visitor_company, 
    visited_person_id, visited_company_id, reason, entry_date, exit_date, 
    photo_url, status, registered_by, created_at, updated_at, 
    registration_number, prevent_auto_exit, liberation_type, 
    period_start, period_end, expected_exit_date, face_embedding, 
    card_number, card_type, photo_base64
)
SELECT 
    id, tenant_id, name, document, rg, cellphone, email, visitor_company, 
    visited_person_id, visited_company_id, reason, entry_date, exit_date, 
    photo_url, status, registered_by, created_at, updated_at, 
    registration_number, prevent_auto_exit, liberation_type, 
    period_start, period_end, expected_exit_date, face_embedding, 
    card_number, card_type, photo_base64
FROM visitors_backup;

-- 5. Restore indexes
CREATE INDEX idx_visitors_status ON visitors(status);
CREATE INDEX idx_visitors_entry_date ON visitors(entry_date);
CREATE INDEX idx_visitors_registration_number ON visitors(registration_number);
CREATE INDEX idx_visitors_document ON visitors(document);
CREATE INDEX idx_visitors_cellphone ON visitors(cellphone);
CREATE INDEX idx_visitors_status_tenant ON visitors(tenant_id, status);

-- 6. Cleanup
DROP TABLE visitors_backup;

COMMIT;
PRAGMA foreign_keys=ON;

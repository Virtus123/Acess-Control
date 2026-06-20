-- Make visitors fields nullable for import functionality
-- SQLite doesn't support MODIFY COLUMN, so we recreate the table

-- Step 1: Create temporary table with full schema and nullable fields
-- This schema matches the visitors table after migrations 012, 027, 035, 036 and 037
-- so it works both for databases that already ran those migrations and for new ones.
CREATE TABLE IF NOT EXISTS visitors_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    document TEXT NOT NULL,
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
    status TEXT DEFAULT 'on_premises',
    registered_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    face_embedding TEXT,
    registration_number TEXT,
    liberation_type TEXT DEFAULT 'unica',
    period_start DATETIME,
    period_end DATETIME,
    expected_exit_date DATETIME,
    prevent_auto_exit INTEGER DEFAULT 0,
    FOREIGN KEY (visited_person_id) REFERENCES persons(id),
    FOREIGN KEY (visited_company_id) REFERENCES companies(id),
    FOREIGN KEY (registered_by) REFERENCES users(id),
    CHECK(status IN ('on_premises', 'exited'))
);

-- Step 2: Copy data from old table using explicit column list
-- This avoids column-count mismatches even if the old table has extra columns
INSERT INTO visitors_new (
    id,
    name,
    document,
    rg,
    cellphone,
    email,
    visitor_company,
    visited_person_id,
    visited_company_id,
    reason,
    entry_date,
    exit_date,
    photo_url,
    status,
    registered_by,
    created_at,
    updated_at,
    face_embedding,
    registration_number,
    liberation_type,
    period_start,
    period_end,
    expected_exit_date,
    prevent_auto_exit
)
SELECT
    id,
    name,
    document,
    rg,
    cellphone,
    email,
    visitor_company,
    visited_person_id,
    visited_company_id,
    reason,
    entry_date,
    exit_date,
    photo_url,
    status,
    registered_by,
    created_at,
    updated_at,
    face_embedding,
    registration_number,
    liberation_type,
    period_start,
    period_end,
    expected_exit_date,
    prevent_auto_exit
FROM visitors;

-- Step 3: Drop old table
DROP TABLE visitors;

-- Step 4: Rename new table
ALTER TABLE visitors_new RENAME TO visitors;

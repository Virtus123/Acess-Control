-- Migration to allow custom IDs in persons table
-- Run this to allow importing with custom IDs from CSV

-- Change the id column to not use autoincrement
-- Note: This removes the autoincrement, allowing explicit ID insertion
DROP TABLE IF EXISTS persons_old;
ALTER TABLE persons RENAME TO persons_old;

CREATE TABLE IF NOT EXISTS persons (
    id INTEGER PRIMARY KEY,
    registration_number TEXT UNIQUE,
    name TEXT NOT NULL,
    cpf TEXT UNIQUE,
    rg TEXT,
    birth_date DATE,
    gender TEXT,
    marital_status TEXT,
    profession TEXT,
    position TEXT,
    admission_date DATE,
    phone TEXT,
    cellphone TEXT NOT NULL,
    email TEXT NOT NULL,
    father_name TEXT,
    mother_name TEXT,
    address TEXT,
    neighborhood TEXT,
    city TEXT,
    state TEXT,
    cep TEXT,
    group_id INTEGER,
    company_id INTEGER,
    photo_url TEXT,
    status TEXT DEFAULT 'active',
    lgpd_consent BOOLEAN DEFAULT 0,
    consent_date DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER,
    nationality TEXT,
    naturality TEXT,
    social_name TEXT,
    registry_name TEXT,
    extension TEXT,
    street_number TEXT,
    address_complement TEXT,
    face_embedding TEXT,
    tenant_id TEXT,
    cellphone_ddi TEXT DEFAULT '+55',
    access_start_date DATETIME,
    access_end_date DATETIME,
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (company_id) REFERENCES companies(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    CHECK(status IN ('active', 'inactive')),
    CHECK(gender IN ('M', 'F', 'O', 'NI'))
);

-- Copy data from old table
INSERT INTO persons (
    id, registration_number, name, cpf, rg, birth_date, gender, marital_status,
    profession, position, admission_date, phone, cellphone, email, father_name,
    mother_name, address, neighborhood, city, state, cep, group_id, company_id,
    photo_url, status, lgpd_consent, consent_date, created_at, updated_at, created_by,
    nationality, naturality, social_name, registry_name, extension, street_number, 
    address_complement, face_embedding, tenant_id, cellphone_ddi,
    access_start_date, access_end_date
)
SELECT 
    id, registration_number, name, cpf, rg, birth_date, gender, marital_status,
    profession, position, admission_date, phone, cellphone, email, father_name,
    mother_name, address, neighborhood, city, state, cep, group_id, company_id,
    photo_url, status, lgpd_consent, consent_date, created_at, updated_at, created_by,
    nationality, naturality, social_name, registry_name, extension, street_number, 
    address_complement, face_embedding, tenant_id, cellphone_ddi,
    access_start_date, access_end_date
FROM persons_old;

-- Drop old table
DROP TABLE persons_old;

-- Do the same for visitors if needed
-- First add tenant_id if it doesn't exist (required by migrate.js)
ALTER TABLE visitors ADD COLUMN tenant_id TEXT;

DROP TABLE IF EXISTS visitors_old;
ALTER TABLE visitors RENAME TO visitors_old;

CREATE TABLE IF NOT EXISTS visitors (
    id INTEGER PRIMARY KEY,
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
    status TEXT DEFAULT 'on_premises',
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
    FOREIGN KEY (visited_person_id) REFERENCES persons(id),
    FOREIGN KEY (visited_company_id) REFERENCES companies(id),
    FOREIGN KEY (registered_by) REFERENCES users(id),
    CHECK(status IN ('on_premises', 'exited'))
);

INSERT INTO visitors (
    id, tenant_id, name, document, rg, cellphone, email, visitor_company,
    visited_person_id, visited_company_id, reason, entry_date, exit_date,
    photo_url, status, registered_by, created_at, updated_at, registration_number,
    prevent_auto_exit, liberation_type, period_start, period_end, expected_exit_date,
    face_embedding
)
SELECT 
    id, 
    COALESCE(tenant_id, '') as tenant_id, 
    name, document, rg, cellphone, email, visitor_company,
    visited_person_id, visited_company_id, reason, entry_date, exit_date,
    photo_url, status, registered_by, created_at, updated_at, registration_number,
    prevent_auto_exit, liberation_type, period_start, period_end, expected_exit_date,
    face_embedding
FROM visitors_old;

DROP TABLE visitors_old;

-- Also update imports table to allow custom IDs
DROP TABLE IF EXISTS imports_old;
ALTER TABLE imports RENAME TO imports_old;

CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
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

INSERT INTO imports (
    id, tenant_id, type, import_with_photo, import_as_inactive, status,
    total, processed, errors, file_path, created_at, updated_at, finished_at
)
SELECT 
    id, tenant_id, type, import_with_photo, import_as_inactive, status,
    total, processed, errors, file_path, created_at, updated_at, finished_at
FROM imports_old;

DROP TABLE imports_old;

-- Update import_errors table too
DROP TABLE IF EXISTS import_errors_old;
ALTER TABLE import_errors RENAME TO import_errors_old;

CREATE TABLE IF NOT EXISTS import_errors (
    id INTEGER PRIMARY KEY,
    import_id INTEGER NOT NULL,
    line_number INTEGER,
    message TEXT,
    raw_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (import_id) REFERENCES imports(id)
);

INSERT INTO import_errors (
    id, import_id, line_number, message, raw_data, created_at
)
SELECT 
    id, import_id, line_number, message, raw_data, created_at
FROM import_errors_old;

DROP TABLE import_errors_old;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_persons_id ON persons(id);
CREATE INDEX IF NOT EXISTS idx_visitors_id ON visitors(id);

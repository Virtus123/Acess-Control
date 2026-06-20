-- Migration: 071_make_persons_fields_nullable
-- Description: Make cellphone and email fields nullable in persons table to allow promoting visitors without these fields.
-- Date: 2026-03-24

-- Step 1: Create a new table without NOT NULL constraints on cellphone and email
CREATE TABLE IF NOT EXISTS persons_new (
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
    cellphone TEXT, -- Made nullable
    email TEXT, -- Made nullable
    father_name TEXT,
    mother_name TEXT,
    social_name TEXT,
    registry_name TEXT,
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
    on_premisse INTEGER DEFAULT 0,
    exited INTEGER DEFAULT 0,
    street_number TEXT,
    address_complement TEXT,
    nationality TEXT,
    naturality TEXT,
    extension TEXT,
    cellphone_ddi TEXT DEFAULT '+55',
    role TEXT NOT NULL DEFAULT 'person',
    password_hash TEXT,
    mobile_permissions TEXT,
    face_embedding TEXT,
    tenant_id TEXT,
    access_start_date DATETIME,
    access_end_date DATETIME,
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (company_id) REFERENCES companies(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    CHECK(status IN ('active', 'inactive')),
    CHECK(gender IN ('M', 'F', 'O', 'NI'))
);

-- Step 2: Copy data from the old table
INSERT INTO persons_new (
  id, registration_number, name, cpf, rg, birth_date, gender, marital_status, 
  profession, position, admission_date, phone, cellphone, email, father_name, 
  mother_name, social_name, registry_name, address, neighborhood, city, state, 
  cep, group_id, company_id, photo_url, status, lgpd_consent, consent_date, 
  created_at, updated_at, created_by, on_premisse, exited, street_number, 
  address_complement, nationality, naturality, extension, cellphone_ddi, 
  role, face_embedding, tenant_id, access_start_date, access_end_date
)
SELECT 
  id, registration_number, name, cpf, rg, birth_date, gender, marital_status, 
  profession, position, admission_date, phone, cellphone, email, father_name, 
  mother_name, social_name, registry_name, address, neighborhood, city, state, 
  cep, group_id, company_id, photo_url, status, lgpd_consent, consent_date, 
  created_at, updated_at, created_by, on_premisse, exited, street_number, 
  address_complement, nationality, naturality, extension, cellphone_ddi, 
  role, face_embedding, tenant_id, access_start_date, access_end_date
FROM persons;

-- Step 3: Drop the old table
DROP TABLE persons;

-- Step 4: Rename the new table
ALTER TABLE persons_new RENAME TO persons;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_persons_registration ON persons(registration_number);
CREATE INDEX IF NOT EXISTS idx_persons_cpf ON persons(cpf);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);
CREATE INDEX IF NOT EXISTS idx_persons_id ON persons(id);
CREATE INDEX IF NOT EXISTS idx_persons_on_premisse ON persons(on_premisse);
CREATE INDEX IF NOT EXISTS idx_persons_exited ON persons(exited);

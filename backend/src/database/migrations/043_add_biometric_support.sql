-- Migration: Add biometric templates support
-- This adds support for remote biometric enrollment via equipment

-- 1. Update access_tasks to support template_remote task type
-- First, we need to recreate the CHECK constraint (SQLite doesn't support ALTER TABLE for constraints)
-- So we'll handle this in the application logic

-- 2. Create table for biometric templates
CREATE TABLE IF NOT EXISTS biometric_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    person_id INTEGER NOT NULL,
    finger_type TEXT NOT NULL, -- 'thumb', 'index', 'middle', 'ring', 'pinky'
    template_data BLOB NOT NULL, -- The actual biometric template
    template_format TEXT DEFAULT 'INNOVATRICS', -- Format of the template
    device_id TEXT, -- Device that captured the template
    identifier_id TEXT, -- Identifier from the device
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
);

-- Indexes for biometric templates
CREATE INDEX IF NOT EXISTS idx_biometric_tenant ON biometric_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_biometric_person ON biometric_templates(person_id);
CREATE INDEX IF NOT EXISTS idx_biometric_active ON biometric_templates(is_active);

-- 3. Add person_id and callback_url columns to access_tasks for template_remote tasks
-- Since SQLite doesn't support ALTER TABLE ADD COLUMN with constraints well, 
-- we'll add them and handle in application
ALTER TABLE access_tasks ADD COLUMN person_id INTEGER;
ALTER TABLE access_tasks ADD COLUMN callback_url TEXT;
ALTER TABLE access_tasks ADD COLUMN finger_type TEXT;

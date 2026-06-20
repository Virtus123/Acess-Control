-- Migration: Add missing fields to persons table
-- Adds: nationality, naturality (birthplace), extension (ramal)

-- Check if columns exist before adding them (SQLite doesn't have IF NOT EXISTS for ALTER TABLE)
PRAGMA foreign_keys=OFF;

-- Add columns if they don't exist
-- Note: SQLite doesn't support IF NOT EXISTS in ALTER TABLE, so we'll handle this in code

ALTER TABLE persons ADD COLUMN nationality TEXT;
ALTER TABLE persons ADD COLUMN naturality TEXT;
ALTER TABLE persons ADD COLUMN extension TEXT;

-- Create index for frequently filtered fields
CREATE INDEX IF NOT EXISTS idx_persons_nationality ON persons(nationality);
CREATE INDEX IF NOT EXISTS idx_persons_naturality ON persons(naturality);

PRAGMA foreign_keys=ON;

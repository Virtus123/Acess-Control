-- Migration: Add additional person fields
-- Adds: social_name, registry_name, access_start_date, access_end_date

PRAGMA foreign_keys=OFF;

-- Add columns if they don't exist
ALTER TABLE persons ADD COLUMN social_name TEXT;
ALTER TABLE persons ADD COLUMN registry_name TEXT;
ALTER TABLE persons ADD COLUMN access_start_date DATETIME;
ALTER TABLE persons ADD COLUMN access_end_date DATETIME;

-- Create indexes for new fields
CREATE INDEX IF NOT EXISTS idx_persons_social_name ON persons(social_name);
CREATE INDEX IF NOT EXISTS idx_persons_registry_name ON persons(registry_name);
CREATE INDEX IF NOT EXISTS idx_persons_access_dates ON persons(access_start_date, access_end_date);

PRAGMA foreign_keys=ON;
-- Add parking_id and company_id columns to vehicles table
-- This allows linking vehicles to parking spots (fixed) or companies (rotative)

ALTER TABLE vehicles ADD COLUMN parking_id INTEGER;
ALTER TABLE vehicles ADD COLUMN company_id INTEGER;
ALTER TABLE vehicles ADD COLUMN spot_number TEXT;
ALTER TABLE vehicles ADD COLUMN tag_number TEXT;

-- Add foreign keys if they don't exist
-- Note: SQLite doesn't support ADD FOREIGN KEY directly, so we'll skip FK constraints

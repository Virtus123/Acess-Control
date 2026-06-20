-- Add user, password and serial fields to equipments table
-- These fields are needed for equipment authentication and identification

ALTER TABLE equipments ADD COLUMN usuario TEXT;
ALTER TABLE equipments ADD COLUMN senha TEXT;
ALTER TABLE equipments ADD COLUMN serial TEXT;

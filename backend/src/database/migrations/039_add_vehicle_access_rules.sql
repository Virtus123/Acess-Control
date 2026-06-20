-- Migration: Add vehicle access rule fields
-- Adds support for vehicle access rules in the access_rules table

-- Add fields for vehicle-based access rules
ALTER TABLE access_rules ADD COLUMN access_target TEXT DEFAULT 'persons';
-- 'persons' = pessoas específicas, empresas, grupos (existing)
-- 'vehicles' = veículos específicos, empresas de veículos, estacionamentos

-- Vehicles data (JSON arrays)
ALTER TABLE access_rules ADD COLUMN vehicles JSON;
ALTER TABLE access_rules ADD COLUMN vehicle_companies JSON;
ALTER TABLE access_rules ADD COLUMN parkings JSON;

-- Parking-specific settings
ALTER TABLE access_rules ADD COLUMN parking_type TEXT;
-- 'rotativo' = rotative parking (company-based)
-- 'fixo' = fixed parking (spot-based)

-- Max vehicles allowed for rotative parking (null = unlimited)
ALTER TABLE access_rules ADD COLUMN max_vehicles INTEGER;

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_access_rules_target ON access_rules(access_target);
CREATE INDEX IF NOT EXISTS idx_access_rules_parking_type ON access_rules(parking_type);

-- Migration: Add address fields to persons table
-- Adds: street_number, address_complement for better address management

ALTER TABLE persons ADD COLUMN street_number TEXT;
ALTER TABLE persons ADD COLUMN address_complement TEXT;

-- Create indexes for commonly queried fields
CREATE INDEX IF NOT EXISTS idx_persons_address ON persons(address);
CREATE INDEX IF NOT EXISTS idx_persons_neighborhood ON persons(neighborhood);

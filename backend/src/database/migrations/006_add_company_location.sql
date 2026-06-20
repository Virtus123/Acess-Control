-- Migration: Add city and state to companies table

ALTER TABLE companies ADD COLUMN city TEXT;
ALTER TABLE companies ADD COLUMN state TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_city ON companies(city);
CREATE INDEX IF NOT EXISTS idx_companies_state ON companies(state);

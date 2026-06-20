-- Migration: 051_add_tenant_id_to_persons_and_companies
-- Description: Add tenant_id column to persons and companies tables for import functionality
-- Date: 2026-03-03

-- Add tenant_id to persons table if not exists
ALTER TABLE persons ADD COLUMN tenant_id TEXT;


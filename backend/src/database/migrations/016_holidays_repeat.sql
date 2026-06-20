-- Migration 016: Add repeat_annual field to holidays table
-- Allows holidays to repeat annually on the same date

ALTER TABLE holidays ADD COLUMN repeat_annual INTEGER DEFAULT 0;

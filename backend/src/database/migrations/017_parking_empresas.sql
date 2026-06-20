-- Migration: Add empresas field to parkings table
-- Stores the distribution of parking spots by company for rotative parking

ALTER TABLE parkings ADD COLUMN empresas TEXT DEFAULT NULL;

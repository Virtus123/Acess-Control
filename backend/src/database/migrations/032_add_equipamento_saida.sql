-- Add equipamento_saida field to equipments table
-- This field identifies if the equipment is an exit point
-- When a visitor passes through an exit equipment, they will be automatically inactivated

ALTER TABLE equipments ADD COLUMN equipamento_saida INTEGER DEFAULT 0;

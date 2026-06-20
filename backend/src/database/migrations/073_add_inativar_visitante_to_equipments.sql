-- Add inativar_visitante field to equipments table
-- This field identifies if the equipment should automatically inactivate visitors on access
-- Separated from equipamento_saida to allow exit points that don't inactivate visitors

ALTER TABLE equipments ADD COLUMN inativar_visitante INTEGER DEFAULT 0;

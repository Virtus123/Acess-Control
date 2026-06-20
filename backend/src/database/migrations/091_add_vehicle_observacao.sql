-- 091_add_vehicle_observacao.sql
-- Campo de observação livre no cadastro de veículos

ALTER TABLE vehicles ADD COLUMN observacao TEXT;

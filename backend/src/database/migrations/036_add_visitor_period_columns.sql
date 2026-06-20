-- Adicionar colunas de período para visitantes
-- Estas colunas são usadas para controle de acesso único

ALTER TABLE visitors ADD COLUMN liberation_type TEXT DEFAULT 'unica';
ALTER TABLE visitors ADD COLUMN period_start DATETIME;
ALTER TABLE visitors ADD COLUMN period_end DATETIME;
ALTER TABLE visitors ADD COLUMN expected_exit_date DATETIME;

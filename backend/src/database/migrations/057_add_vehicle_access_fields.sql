-- Migration 057: Adicionar campos para controle de acesso de veículos
--Objetivos:
-- 1. Controle de presença de pessoas (on_premisse, exited)
-- 2. Campos de veículo no log de acesso (plate, company_id, vehicle_id)
-- 3. Campo access_type para distinguir acesso de pessoa vs veículo

-- ============================================
-- 1. Adicionar campos de controle de presença na tabela persons
-- ============================================
ALTER TABLE persons ADD COLUMN on_premisse INTEGER DEFAULT 0;
ALTER TABLE persons ADD COLUMN exited INTEGER DEFAULT 0;

-- ============================================
-- 2. Adicionar campos de veículo na tabela access_log
-- ============================================
ALTER TABLE access_log ADD COLUMN vehicle_id INTEGER;
ALTER TABLE access_log ADD COLUMN plate TEXT;
ALTER TABLE access_log ADD COLUMN company_id INTEGER;

-- ============================================
-- 3. Adicionar campo access_type para distinguir pessoa vs veículo
-- ============================================
ALTER TABLE access_log ADD COLUMN access_type TEXT DEFAULT 'PERSON' CHECK(access_type IN ('PERSON', 'VEHICLE'));

-- ============================================
-- 4. Adicionar índice para buscar logs de veículos por placa
-- ============================================
CREATE INDEX IF NOT EXISTS idx_access_log_plate ON access_log(plate);
CREATE INDEX IF NOT EXISTS idx_access_log_vehicle_id ON access_log(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_access_log_access_type ON access_log(access_type);

-- ============================================
-- 5. Adicionar índice para controle de presença de pessoas
-- ============================================
CREATE INDEX IF NOT EXISTS idx_persons_on_premisse ON persons(on_premisse);
CREATE INDEX IF NOT EXISTS idx_persons_exited ON persons(exited);

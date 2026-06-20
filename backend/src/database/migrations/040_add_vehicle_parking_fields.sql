-- Adicionar campos necessários para controle de estacionamento de veículos
-- Migration 040_add_vehicle_parking_fields.sql
-- Nota: company_id e parking_id já são criados na migração 027
-- Esta migração adiciona apenas os novos campos: plate e status

-- Adicionar coluna plate (alias para license_plate para facilitar)
ALTER TABLE vehicles ADD COLUMN plate TEXT;

-- Adicionar coluna status para controle de entrada/saída do veículo
ALTER TABLE vehicles ADD COLUMN status TEXT DEFAULT 'inactive' CHECK(status IN ('active', 'inactive'));

-- Criar índice para busca por placa
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate);

-- Criar índice para busca por status
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);

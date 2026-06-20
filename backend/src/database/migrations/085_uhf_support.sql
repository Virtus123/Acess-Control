-- Migration 085: Suporte a tags UHF (IDUHF)
-- Adiciona campo dedicado uhf_tag na tabela vehicles e coluna source no access_log

-- Campo UHF dedicado por veículo (separado do tag_number genérico de RFID/cartão)
ALTER TABLE vehicles ADD COLUMN uhf_tag TEXT;

-- Índice para busca performática por tag UHF
CREATE INDEX IF NOT EXISTS idx_vehicles_uhf_tag ON vehicles(uhf_tag);

-- Garantir índice no tag_number legado (pode já existir)
CREATE INDEX IF NOT EXISTS idx_vehicles_tag_number ON vehicles(tag_number);

-- Origem do evento de acesso: 'manual', 'uhf', 'facial', 'biometric', 'card'
ALTER TABLE access_log ADD COLUMN source TEXT DEFAULT 'manual';

-- Tag UHF utilizada no acesso (para rastreabilidade)
ALTER TABLE access_log ADD COLUMN uhf_tag TEXT;

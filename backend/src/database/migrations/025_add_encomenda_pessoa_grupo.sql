-- Migration 025: Adicionar campos de vínculo com pessoa/grupo na tabela encomendas
-- Permite vincular uma encomenda a um grupo e pessoa específicos

ALTER TABLE encomendas ADD COLUMN destinatario_grupo_id INTEGER;
ALTER TABLE encomendas ADD COLUMN destinatario_pessoa_id INTEGER;

-- Criar índices para melhorar performance
CREATE INDEX IF NOT EXISTS idx_encomendas_grupo_id ON encomendas(destinatario_grupo_id);
CREATE INDEX IF NOT EXISTS idx_encomendas_pessoa_id ON encomendas(destinatario_pessoa_id);

-- Migration 026: Adicionar coluna de e-mails para notificações na tabela de grupos
-- Permite configurar até 4 e-mails para envio de notificações de encomendas

ALTER TABLE groups ADD COLUMN emails TEXT;

-- Criar índice para performance
CREATE INDEX IF NOT EXISTS idx_groups_emails ON groups(emails);

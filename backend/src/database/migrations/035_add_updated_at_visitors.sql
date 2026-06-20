-- Migration: Adicionar coluna updated_at na tabela visitors
-- Necessário para o sistema de autorização inativar visitantes por saída

ALTER TABLE visitors ADD COLUMN updated_at TEXT;

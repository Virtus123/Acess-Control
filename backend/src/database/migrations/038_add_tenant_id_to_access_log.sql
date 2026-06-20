-- Migration: Adicionar coluna tenant_id na tabela access_log se não existir
-- Necessário porque a tabela pode ter sido criada sem essa coluna em tenants antigos

-- Verificar se a coluna já existe antes de adicionar
-- SQLite não suporta IF NOT EXISTS para ALTER TABLE ADD COLUMN, então precisamos verificar manualmente
-- Esta migration usa um script de verificação

-- Nota: Esta migration será executada pelo sistema de migrations do Node
-- O comando SQL real será executado pelo migrator

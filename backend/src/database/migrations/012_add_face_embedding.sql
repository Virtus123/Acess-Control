-- =====================================================
-- MIGRAÇÃO 012: Campos de Embedding Facial
-- Data: 2026-02-17
-- =====================================================

-- =====================================================
-- 1. ADICIONAR CAMPOS DE EMBEDDING NA TABELA persons
-- =====================================================
-- Embedding facial (salvo como JSON - array de 128 números)
ALTER TABLE persons ADD COLUMN face_embedding TEXT;

-- =====================================================
-- 2. ADICIONAR CAMPOS DE EMBEDDING NA TABELA visitors
-- =====================================================
ALTER TABLE visitors ADD COLUMN face_embedding TEXT;

-- =====================================================
-- 3. ÍNDICES PARA BUSCA DE EMBEDDING
-- =====================================================
-- Não é possível indexar campos TEXT grandes no SQLite
-- A busca será feita via aplicação comparando vetores

-- =====================================================
-- FIM DA MIGRAÇÃO 012
-- =====================================================

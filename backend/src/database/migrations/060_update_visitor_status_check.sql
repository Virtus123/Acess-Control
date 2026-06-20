-- Migração 060: Atualizar CHECK constraint da coluna status na tabela visitors para incluir 'inactive'
-- Esta validação foi movida para ensureVisitorsStatusConstraint no JS
-- Devido as colunas como photo_base64 só serem garantidas pós-scripts.
SELECT 1;
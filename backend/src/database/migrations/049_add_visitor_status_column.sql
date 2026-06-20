-- Migração 049: Coluna status agora é garantida pela função ensureVisitorsColumns
-- Esta migração é mantida apenas para não quebrar a sequência de versões
-- A coluna status é verificada e adicionada automaticamente após as migrações SQL
SELECT 1;

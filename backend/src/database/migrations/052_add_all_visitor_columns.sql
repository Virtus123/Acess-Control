-- Migração 052: Colunas visitors agora são garantidas pela função ensureVisitorsColumns
-- Esta migração é mantida apenas para não quebrar a sequência de versões
-- As colunas são verificadas e adicionadas automaticamente após as migrações SQL
SELECT 1;

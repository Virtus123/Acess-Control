-- Adiciona coluna is_incremental à price_ranges (faltava na criação original)
-- Coluna usada pelo motor de cálculo de faturamento para distinguir faixas base vs. adicionais
ALTER TABLE price_ranges ADD COLUMN is_incremental INTEGER DEFAULT 0;

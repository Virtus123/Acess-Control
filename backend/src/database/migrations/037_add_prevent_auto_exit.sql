-- Adicionar coluna para impedir saída automática do visitante
-- Quando true, o visitante não será dado como "exited" ao sair
-- Só será bloqueado quando o período de liberação expirar
ALTER TABLE visitors ADD COLUMN prevent_auto_exit INTEGER DEFAULT 0;

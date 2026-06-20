-- Adicionar campos de prioridade e lida na tabela de notificações globais
ALTER TABLE global_notifications ADD COLUMN is_prioritary INTEGER DEFAULT 0;
ALTER TABLE global_notifications ADD COLUMN is_read INTEGER DEFAULT 0;

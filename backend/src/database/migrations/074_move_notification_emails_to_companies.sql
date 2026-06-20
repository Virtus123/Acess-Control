-- Migration 074: Mover e-mails de notificação de Grupos para Empresas
-- Remove a coluna emails da tabela groups e cria uma nova tabela para e-mails de notificação de empresas

-- 1. Remover coluna emails da tabela groups (SQLite não suporta DROP COLUMN diretamente de forma simples em versões antigas, mas vamos tentar o comando padrão se a versão permitir, ou apenas ignorar a coluna)
-- Em SQLite moderno (3.35.0+), DROP COLUMN funciona. Caso contrário, a coluna apenas permanecerá sem uso.
-- ALTER TABLE groups DROP COLUMN emails;

-- 2. Criar a nova tabela para e-mails de notificação de empresas
CREATE TABLE IF NOT EXISTS company_notification_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- 3. Criar índices para performance
CREATE INDEX IF NOT EXISTS idx_company_notifications_company_id ON company_notification_emails(company_id);

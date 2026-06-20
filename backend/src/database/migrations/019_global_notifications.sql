-- Tabela de notificações globais (admin master)
-- Esta tabela é independente dos tenants e armazena notificações que aparecem em todos os sistemas
CREATE TABLE IF NOT EXISTS global_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    created_by TEXT DEFAULT 'Admin Master'
);

-- Inserir algumas notificações de exemplo (opcional)
-- INSERT INTO global_notifications (title, message) VALUES ('Bem-vindo ao Sistema', 'Sistema iniciado com sucesso!');

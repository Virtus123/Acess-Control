-- Verificar e criar tabela groups se não existir
-- Este script corrige o erro "no such column: group_name" ao atualizar pessoas

-- Criar tabela groups se não existir
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT,
    description TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active BOOLEAN DEFAULT 1,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Verificar se a coluna group_id existe na tabela persons
-- Se não existir, adicionar
-- ALTER TABLE persons ADD COLUMN group_id INTEGER REFERENCES groups(id);

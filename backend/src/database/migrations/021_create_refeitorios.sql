-- Migration: Create refeitorios table
-- Date: 2026-02-22

CREATE TABLE IF NOT EXISTS refeitorios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    local TEXT,
    capacidade INTEGER,
    tipo TEXT DEFAULT 'interno',
    horario_abertura TEXT DEFAULT '07:00',
    horario_fechamento TEXT DEFAULT '19:00',
    observacoes TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_refeitorios_nome ON refeitorios(nome);

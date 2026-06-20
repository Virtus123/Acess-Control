-- Migration 075: Notification System Updates
-- Handles tenant config and notifications table structure

-- 1. Table: notificacoes (Ensuring correct structure)
CREATE TABLE IF NOT EXISTS notificacoes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nome        TEXT NOT NULL,
  tipo_evento TEXT NOT NULL,
  grupos      TEXT DEFAULT '[]',
  assunto     TEXT NOT NULL,
  corpo       TEXT NOT NULL,
  ativo       INTEGER DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Table: tenant_config
CREATE TABLE IF NOT EXISTS tenant_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

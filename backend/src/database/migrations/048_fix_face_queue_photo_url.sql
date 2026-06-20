-- Migration 048: Fix face_queue photo_url NOT NULL constraint
-- Execute diretamente com: sqlite3 database/tenants/tenant_demo.db < src/database/migrations/048_fix_face_queue_photo_url.sql

-- Primeiro, remover tabela temporária se existir
DROP TABLE IF EXISTS face_queue_old;

-- Renomear tabela antiga
ALTER TABLE face_queue RENAME TO face_queue_old;

-- Criar nova tabela sem NOT NULL na coluna photo_url
CREATE TABLE face_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  person_id INTEGER NOT NULL,
  person_name TEXT NOT NULL,
  person_type TEXT NOT NULL,
  photo_url TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

-- Copiar dados apenas das colunas que existem na tabela antiga
INSERT INTO face_queue (id, tenant_id, person_id, person_name, person_type, photo_url, status, created_at, updated_at)
SELECT id, tenant_id, person_id, person_name, person_type, photo_url, status, created_at, updated_at FROM face_queue_old;

-- Remover tabela antiga
DROP TABLE face_queue_old;

-- Recriar índices
CREATE INDEX IF NOT EXISTS idx_face_queue_tenant_status ON face_queue(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_face_queue_person ON face_queue(person_id, person_type);

-- Migration: Create face_queue table
-- Descrição: Tabela para fila de processamento de faces (pessoas/visitantes pendentes de sync com comunicador)

CREATE TABLE IF NOT EXISTS face_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  person_name TEXT NOT NULL,
  person_type TEXT NOT NULL CHECK(person_type IN ('person', 'visitor')),
  photo_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'error')),
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_face_queue_tenant_status ON face_queue(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_face_queue_person ON face_queue(person_id, person_type);

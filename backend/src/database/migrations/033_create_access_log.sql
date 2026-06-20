-- Migration: Criar tabela de logs de acesso
-- Tabela para registrar todos os acessos processados pelo sistema de autorização

CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    person_id INTEGER NOT NULL,
    person_type TEXT NOT NULL CHECK (person_type IN ('person', 'visitor')),
    equipment_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT', 'DENIED')),
    status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
    message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (equipment_id) REFERENCES equipments(id)
);

-- Índices para otimizar consultas
CREATE INDEX IF NOT EXISTS idx_access_log_tenant ON access_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_person ON access_log(person_id, person_type);
CREATE INDEX IF NOT EXISTS idx_access_log_equipment ON access_log(equipment_id);
CREATE INDEX IF NOT EXISTS idx_access_log_status ON access_log(status);

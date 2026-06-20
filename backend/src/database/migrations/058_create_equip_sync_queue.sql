-- Migration: Create equip_sync_queue table
-- Descrição: Tabela para gerenciar a fila de sincronização sequencial de equipamentos

CREATE TABLE IF NOT EXISTS equip_sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    equip_validator TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'syncing', 'completed', 'canceled')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_equip_sync_queue_tenant_status ON equip_sync_queue(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_equip_sync_queue_validator ON equip_sync_queue(equip_validator);

-- Create equipments table for device management
-- This table stores all equipment/devices used in the access control system

CREATE TABLE IF NOT EXISTS equipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    equip_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    marca TEXT,
    modelo TEXT,
    ip_address TEXT,
    port INTEGER DEFAULT 8080,
    tipo TEXT NOT NULL DEFAULT 'facial_entrada',
    validador TEXT,
    controla_estacionamento INTEGER DEFAULT 0,
    localizacao TEXT,
    descricao TEXT,
    status TEXT DEFAULT 'active',
    online INTEGER DEFAULT 0,
    last_connection DATETIME,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_equipments_tenant_id ON equipments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_equipments_equip_id ON equipments(equip_id);
CREATE INDEX IF NOT EXISTS idx_equipments_tipo ON equipments(tipo);
CREATE INDEX IF NOT EXISTS idx_equipments_active ON equipments(active);

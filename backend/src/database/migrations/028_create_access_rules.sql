-- Tabela de Regras de Acesso para Pessoas
-- Utilizada para controlar quem pode acessar quais equipamentos e em quais horários

CREATE TABLE IF NOT EXISTS access_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    
    -- Tipo de acesso: pessoas-especificas, pessoas-geral, visitantes-geral, empresas, grupos, todos
    access_type TEXT NOT NULL DEFAULT 'pessoas-especificas',
    
    -- Dados específicos baseados no tipo (JSON arrays)
    persons JSON,        -- IDs das pessoas específicas [1,2,3]
    companies JSON,       -- IDs das empresas [1,2,3]
    groups JSON,         -- IDs dos grupos [1,2,3]
    
    -- Equipamentos autorizados (JSON array de equipment IDs)
    equipments JSON NOT NULL,
    
    -- Horários autorizados
    schedule_type TEXT NOT NULL DEFAULT 'especifico',  -- 'especifico' ou 'livre'
    schedules JSON,     -- IDs dos horários [1,2,3] - usado quando schedule_type = 'especifico'
    
    -- Status
    active INTEGER NOT NULL DEFAULT 1,
    
    -- Timestamps
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_access_rules_tenant ON access_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_access_rules_active ON access_rules(active);

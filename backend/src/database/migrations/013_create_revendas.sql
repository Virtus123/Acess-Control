-- Tabela de Revendas (criar no tenant admin master: acesscontrolmaster)
-- Execute este SQL no banco de dados do tenant acesscontrolmaster

-- Tabela de revendas
CREATE TABLE IF NOT EXISTS revendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT UNIQUE NOT NULL,
    cnpj TEXT NOT NULL,
    corporate_name TEXT NOT NULL,
    trading_name TEXT,
    representative_name TEXT NOT NULL,
    representative_cpf TEXT NOT NULL,
    representative_email TEXT NOT NULL,
    admin_email TEXT NOT NULL,
    admin_password TEXT NOT NULL,
    phone TEXT,
    city TEXT,
    state TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de revenda_tenants (associa tenants às revendas)
CREATE TABLE IF NOT EXISTS revenda_tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revenda_id INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (revenda_id) REFERENCES revendas(id) ON DELETE CASCADE,
    UNIQUE(revenda_id, tenant_id)
);

--seed para adicionar revendas existentes (vazio por enquanto)
-- INSERT INTO revendas (tenant_id, cnpj, corporate_name, trading_name, representative_name, representative_cpf, representative_email, admin_email, admin_password) VALUES (...)

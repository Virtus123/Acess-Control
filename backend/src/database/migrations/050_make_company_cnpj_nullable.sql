-- Tornar coluna CNPJ da tabela companies nullable
-- Para permitir cadastro de empresas sem CNPJ
-- Remove a restrição UNIQUE para permitir múltiplos CNPJs nulos

-- SQLite não suporta ALTER COLUMN para remover NOT NULL
-- A solução é recriar a tabela sem o NOT NULL e sem UNIQUE no CNPJ

-- Verificar se a tabela companies_temp não existe (limpeza de migrações anteriores)
DROP TABLE IF EXISTS companies_temp;

-- Criar tabela temporária sem NOT NULL para CNPJ e sem UNIQUE
CREATE TABLE companies_temp (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corporate_name TEXT NOT NULL,
    trading_name TEXT,
    cnpj TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active BOOLEAN DEFAULT 1,
    group_id INTEGER,
    tenant_id TEXT,
    city TEXT,
    state TEXT,
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Copiar dados da tabela original para a temporária
INSERT INTO companies_temp (
    id, corporate_name, trading_name, cnpj, phone, email, 
    address, created_by, created_at, active, group_id, tenant_id, city, state
)
SELECT 
    id, corporate_name, trading_name, cnpj, phone, email, 
    address, created_by, created_at, active, group_id, tenant_id, city, state
FROM companies;

-- Remover tabela original
DROP TABLE companies;

-- Renomear tabela temporária para o nome original
ALTER TABLE companies_temp RENAME TO companies;

-- Recriar índices
CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id);

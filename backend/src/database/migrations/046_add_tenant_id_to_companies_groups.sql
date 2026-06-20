-- Adicionar coluna tenant_id às tabelas companies e groups
-- Isso é necessário para o sistema de importação que usa tenant_id

-- Verificar se a coluna tenant_id já existe na tabela companies
ALTER TABLE companies ADD COLUMN tenant_id TEXT;

-- Verificar se a coluna tenant_id já existe na tabela groups  
ALTER TABLE groups ADD COLUMN tenant_id TEXT;

-- Criar índices para melhorar performance de busca por tenant
CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_groups_tenant ON groups(tenant_id);

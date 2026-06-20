-- Performance indexes para otimizar consultas em tabelas grandes
-- Este script cria índices para melhorar a performance de consultas em pessoas, veículos e visitantes

-- ============================================
-- ÍNDICES PARA TABELA PERSONS (Pessoas)
-- ============================================

-- Índice para busca por nome (muito usado em filtros)
CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);

-- Índice para busca por CPF
CREATE INDEX IF NOT EXISTS idx_persons_cpf ON persons(cpf);

-- Índice para busca por matrícula
CREATE INDEX IF NOT EXISTS idx_persons_registration_number ON persons(registration_number);

-- Índice para status (filtro comum)
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);

-- Índice para grupo (JOIN com groups)
CREATE INDEX IF NOT EXISTS idx_persons_group_id ON persons(group_id);

-- Índice para empresa (JOIN com companies)
CREATE INDEX IF NOT EXISTS idx_persons_company_id ON persons(company_id);

-- Índice para data de criação (ordenação)
CREATE INDEX IF NOT EXISTS idx_persons_created_at ON persons(created_at);

-- ============================================
-- ÍNDICES PARA TABELA VEHICLES (Veículos)
-- ============================================

-- Índice para busca por placa (license_plate)
CREATE INDEX IF NOT EXISTS idx_vehicles_license_plate ON vehicles(license_plate);

-- Índice para pessoa associada (JOIN)
CREATE INDEX IF NOT EXISTS idx_vehicles_person_id ON vehicles(person_id);

-- ============================================
-- ÍNDICES PARA TABELA VISITORS (Visitantes)
-- ============================================

-- Índice para busca por nome
CREATE INDEX IF NOT EXISTS idx_visitors_name ON visitors(name);

-- Nota: A coluna de documento pode ser 'cpf' ou 'document' dependendo do tenant
-- O índice será criado condicionalmente via script ou pode ser adicionado manualmente

-- Índice para RG
CREATE INDEX IF NOT EXISTS idx_visitors_rg ON visitors(rg);

-- Índice para status
CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status);

-- Índice para data de criação
CREATE INDEX IF NOT EXISTS idx_visitors_created_at ON visitors(created_at);

-- ============================================
-- ÍNDICES PARA TABELA COMPANIES (Empresas)
-- ============================================

-- Índice para razão social
CREATE INDEX IF NOT EXISTS idx_companies_corporate_name ON companies(corporate_name);

-- Índice para nome fantasia
CREATE INDEX IF NOT EXISTS idx_companies_trading_name ON companies(trading_name);

-- Índice para CNPJ
CREATE INDEX IF NOT EXISTS idx_companies_cnpj ON companies(cnpj);

-- Índice para active
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(active);

-- ============================================
-- ÍNDICES PARA TABELA GROUPS (Grupos)
-- ============================================

-- Índice para nome do grupo
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

-- ============================================
-- ÍNDICES PARA TABELA ACCESS_LOG
-- ============================================

-- Índice para busca por pessoa
CREATE INDEX IF NOT EXISTS idx_access_log_person_id ON access_log(person_id);

-- Índice para busca por data (created_at)
CREATE INDEX IF NOT EXISTS idx_access_log_created_at ON access_log(created_at);

-- Índice para busca por equipamento
CREATE INDEX IF NOT EXISTS idx_access_log_equipment_id ON access_log(equipment_id);

-- Índice para tenant
CREATE INDEX IF NOT EXISTS idx_access_log_tenant_id ON access_log(tenant_id);

-- Índice para action (entrada/saída)
CREATE INDEX IF NOT EXISTS idx_access_log_action ON access_log(action);

-- Índice para status
CREATE INDEX IF NOT EXISTS idx_access_log_status ON access_log(status);

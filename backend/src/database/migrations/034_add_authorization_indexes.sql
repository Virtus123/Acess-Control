-- Migration: Índices para Otimização do Sistema de Autorização
-- Índices para consultas rápidas em equipamentos, pessoas, visitantes e regras

-- ============================================
-- ÍNDICES PARA EQUIPMENTS
-- ============================================

-- Índice para busca por validador (usado em toda autorização)
CREATE INDEX IF NOT EXISTS idx_equipments_validador ON equipments(validador);
CREATE INDEX IF NOT EXISTS idx_equipments_active ON equipments(active);

-- ============================================
-- ÍNDICES PARA PERSONS
-- ============================================

-- Índice para busca por ID (usado em toda autorização)
CREATE INDEX IF NOT EXISTS idx_persons_id ON persons(id);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);

-- ============================================
-- ÍNDICES PARA VISITORS
-- ============================================

-- Índice para busca por ID (usado em toda autorização)
CREATE INDEX IF NOT EXISTS idx_visitors_id ON visitors(id);
CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status);

-- ============================================
-- ÍNDICES PARA ACCESS_RULES
-- ============================================

-- Índice para buscar regras ativas rapidamente (coluna é 'active', não 'status')
CREATE INDEX IF NOT EXISTS idx_access_rules_active ON access_rules(active);
CREATE INDEX IF NOT EXISTS idx_access_rules_tenant ON access_rules(tenant_id);

-- ============================================
-- ÍNDICES PARA SCHEDULES
-- ============================================

-- Índice para busca por ID de horário
CREATE INDEX IF NOT EXISTS idx_schedules_id ON schedules(id);

-- ============================================
-- ÍNDICES PARA VEHICLES
-- ============================================

-- Índice para busca de veículo por pessoa (não tem coluna status na tabela vehicles)
CREATE INDEX IF NOT EXISTS idx_vehicles_person ON vehicles(person_id);

-- ============================================
-- ÍNDICES PARA ACCESS_LOG
-- ============================================

-- Índices para logs de acesso
CREATE INDEX IF NOT EXISTS idx_access_log_tenant_time ON access_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_person ON access_log(person_id, person_type);
CREATE INDEX IF NOT EXISTS idx_access_log_equipment ON access_log(equipment_id);
CREATE INDEX IF NOT EXISTS idx_access_log_status ON access_log(status);

-- ============================================
-- ÍNDICES PARA SCHEDULE_RANGES
-- ============================================

-- Índices para schedule_ranges (dias da semana e horários)
CREATE INDEX IF NOT EXISTS idx_schedule_ranges_schedule ON schedule_ranges(schedule_id);
CREATE INDEX IF NOT EXISTS idx_schedule_ranges_day ON schedule_ranges(day_of_week);

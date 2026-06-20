-- Índices de performance para queries mais comuns
-- Impacto: relatórios, logs de acesso, listagens e fila de sincronização

-- access_log: filtros por data, equipamento e pessoa (relatórios e dashboard)
CREATE INDEX IF NOT EXISTS idx_access_log_created_at ON access_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_equipment_id ON access_log(equipment_id);
CREATE INDEX IF NOT EXISTS idx_access_log_person_id ON access_log(person_id);
CREATE INDEX IF NOT EXISTS idx_access_log_tenant_date ON access_log(tenant_id, created_at DESC);

-- persons: listagem por status e busca por nome/matrícula
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);
CREATE INDEX IF NOT EXISTS idx_persons_name ON persons(name);
CREATE INDEX IF NOT EXISTS idx_persons_registration ON persons(registration_number);

-- visitors: filtro por status e data de entrada
CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status);
CREATE INDEX IF NOT EXISTS idx_visitors_entry_date ON visitors(entry_date DESC);

-- face_queue: processamento do comunicador
CREATE INDEX IF NOT EXISTS idx_face_queue_status ON face_queue(status);

-- equip_sync_queue: fila de sincronização
CREATE INDEX IF NOT EXISTS idx_equip_sync_status ON equip_sync_queue(status);

-- equipments: lookup por validador (comunicador)
CREATE INDEX IF NOT EXISTS idx_equipments_validator ON equipments(validador);

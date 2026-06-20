-- Tabela de relacionamento many-to-many entre empresas e grupos
CREATE TABLE IF NOT EXISTS company_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id),
    UNIQUE(company_id, group_id)
);

-- Índices para melhorar performance
CREATE INDEX IF NOT EXISTS idx_company_groups_company ON company_groups(company_id);
CREATE INDEX IF NOT EXISTS idx_company_groups_group ON company_groups(group_id);

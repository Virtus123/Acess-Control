CREATE TABLE IF NOT EXISTS tenant_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    max_pessoas INTEGER DEFAULT 1000,
    max_equipamentos INTEGER DEFAULT 50,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tenant_limits (max_pessoas, max_equipamentos) VALUES (1000, 50);

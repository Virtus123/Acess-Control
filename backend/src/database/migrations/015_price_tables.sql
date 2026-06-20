-- Tabela de preços para controle de mensalidade por quantidade de cadastros
CREATE TABLE IF NOT EXISTS price_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de faixas de preços
CREATE TABLE IF NOT EXISTS price_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price_table_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL, -- 'pessoas' ou 'equipamentos'
    min_quantity INTEGER NOT NULL, -- quantidade mínima (0 para inicial)
    max_quantity INTEGER NOT NULL, -- quantidade máxima (NULL para ilimitado)
    price REAL NOT NULL, -- preço para esta faixa
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (price_table_id) REFERENCES price_tables(id) ON DELETE CASCADE
);

-- Inserir tabela de preços padrão
INSERT OR IGNORE INTO price_tables (id, name, description) 
VALUES (1, 'Plano Padrão', 'Plano padrão com preços por faixa de cadastros');

-- Inserir faixas de preços padrão
INSERT OR IGNORE INTO price_ranges (price_table_id, entity_type, min_quantity, max_quantity, price) VALUES
(1, 'pessoas', 0, 500, 100),
(1, 'pessoas', 501, 600, 170),
(1, 'pessoas', 601, 700, 240),
(1, 'pessoas', 701, 800, 310),
(1, 'pessoas', 801, 900, 380),
(1, 'pessoas', 901, 1000, 450),
(1, 'pessoas', 1001, 1100, 520),
(1, 'pessoas', 1101, 1200, 590),
(1, 'pessoas', 1201, NULL, 660),
(1, 'equipamentos', 0, 5, 50),
(1, 'equipamentos', 6, 10, 70),
(1, 'equipamentos', 11, 15, 90),
(1, 'equipamentos', 16, 20, 110),
(1, 'equipamentos', 21, 25, 130),
(1, 'equipamentos', 26, 30, 150),
(1, 'equipamentos', 31, NULL, 170);

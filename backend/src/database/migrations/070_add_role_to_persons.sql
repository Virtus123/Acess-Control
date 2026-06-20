-- Adiciona a coluna role para diferenciar tipos de usuários no mobile
ALTER TABLE persons ADD COLUMN role TEXT NOT NULL DEFAULT 'person';
-- Valores possíveis: 'admin', 'operator', 'person'

-- Adicionar coluna group_id na tabela companies para vincular empresas a grupos
ALTER TABLE companies ADD COLUMN group_id INTEGER REFERENCES groups(id);

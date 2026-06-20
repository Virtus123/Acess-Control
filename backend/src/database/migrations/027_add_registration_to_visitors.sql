-- Adiciona coluna registration_number para visitantes (matrícula começa com 27)
ALTER TABLE visitors ADD COLUMN registration_number TEXT;

-- Adiciona índice para buscar matrículas de visitantes rapidamente
CREATE INDEX IF NOT EXISTS idx_visitors_registration_number ON visitors(registration_number);

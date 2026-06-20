-- Limpar pessoas duplicadas
UPDATE persons 
SET registration_number = registration_number || '_dup_' || id
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY registration_number ORDER BY id) as rn
    FROM persons
    WHERE registration_number IS NOT NULL
  ) WHERE rn > 1
);

-- Limpar visitantes duplicados
UPDATE visitors 
SET registration_number = registration_number || '_dup_' || id
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY registration_number ORDER BY id) as rn
    FROM visitors
    WHERE registration_number IS NOT NULL
  ) WHERE rn > 1
);

-- Criar índices únicos
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_persons_registration ON persons(registration_number) WHERE registration_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_visitors_registration ON visitors(registration_number) WHERE registration_number IS NOT NULL;

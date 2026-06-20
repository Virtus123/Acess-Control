-- Migration: Adicionar 'vehicle' ao CHECK constraint de person_type
-- Necessário para registrar acessos de veículos na tabela access_log
-- Esta migration detecta automaticamente o estado atual da tabela

-- Verificar se a coluna vehicle_id já existe na tabela access_log
-- Se existir, copiá-la para a nova tabela

-- Primeiro, verificar quantas colunas a tabela tem
SELECT 1;  -- Placeholder para verificação via código

-- A migration real será handled pelo ensureAccessLogVehicleColumn em migrate.js
-- Este arquivo SQL é apenas um marcador para registro na schema_migrations

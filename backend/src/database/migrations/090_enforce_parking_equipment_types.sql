-- 090_enforce_parking_equipment_types.sql
-- Desliga controla_estacionamento de qualquer equipamento que NÃO seja de pátio.
-- Catraca (controle_acesso), biometria, cartao, qrcode, outro: nunca controlam vaga.

UPDATE equipments
SET controla_estacionamento = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE controla_estacionamento = 1
  AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
  AND (modelo IS NULL OR modelo <> 'IDUHF');

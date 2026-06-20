// Fonte única da regra: quem participa do fluxo VEICULAR (estacionamento).
// Usa os valores REAIS gravados no banco (ver tipoMap em equipmentController.js),
// NÃO os rótulos do frontend. Catraca / Henry / iDBlock => 'controle_acesso'.

const PARKING_EQUIPMENT_TIPOS = new Set([
  'facial_entrada',
  'facial_saida',
  'uhf',
  'tag',
]);

const VEHICLE_READER_TIPOS = new Set(['uhf', 'tag']);

/**
 * É um equipamento que PODE operar no pátio (allowlist por tipo)?
 * Catraca (controle_acesso/biometria/cartao/qrcode/outro) => false, sempre.
 */
export function isParkingEquipment(equipment) {
  if (!equipment) return false;
  if (equipment.modelo === 'IDUHF') return true;
  return PARKING_EQUIPMENT_TIPOS.has(equipment.tipo);
}

/**
 * DECISÃO FINAL: participa do controle de vagas?
 * Regra: precisa SER de pátio E ter o flag ligado.
 * Catraca com checkbox marcado por engano cai fora aqui.
 */
export function participatesInParkingControl(equipment) {
  if (!isParkingEquipment(equipment)) return false;
  return equipment.controla_estacionamento === 1
      || equipment.controla_estacionamento === true;
}

/**
 * É leitor veicular (UHF/TAG)? Identifica veículo pela tag/placa,
 * jamais usa "primeiro veículo cadastrado".
 */
export function isVehicleReader(equipment) {
  if (!equipment) return false;
  if (equipment.modelo === 'IDUHF') return true;
  return VEHICLE_READER_TIPOS.has(equipment.tipo);
}

export { PARKING_EQUIPMENT_TIPOS };

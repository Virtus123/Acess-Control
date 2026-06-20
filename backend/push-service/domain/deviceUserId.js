// Cópia sincronizada de backend/src/services/deviceUserId.js
// Mantém o Push isolado do backend antigo, mas com a MESMA regra de domínio.
// Se alterar este arquivo, alterar TAMBÉM:
//   backend/src/services/deviceUserId.js

export const VISITOR_ID_OFFSET = 1_000_000_000;

export function toDeviceUserId(type, internalId, registrationNumber) {
  if (registrationNumber !== null && registrationNumber !== undefined && registrationNumber !== '') {
    const onlyDigits = String(registrationNumber).replace(/\D/g, '');
    const matricula = parseInt(onlyDigits, 10);
    if (!Number.isNaN(matricula) && matricula > 0) return matricula;
  }
  const id = parseInt(internalId, 10);
  if (Number.isNaN(id) || id < 0) {
    throw new Error(`deviceUserId: id interno inválido (${internalId})`);
  }
  if (type === 'visitor') return id + VISITOR_ID_OFFSET;
  if (type === 'person')  return id;
  throw new Error(`deviceUserId: type desconhecido (${type})`);
}

export function classifyDeviceUserId(deviceUserId) {
  const n = parseInt(deviceUserId, 10);
  if (!Number.isNaN(n) && n >= VISITOR_ID_OFFSET) {
    return { isVisitorFallback: true, visitorInternalId: n - VISITOR_ID_OFFSET };
  }
  return { isVisitorFallback: false, visitorInternalId: null };
}

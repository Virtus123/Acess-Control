// =============================================================================
// deviceUserId — mapeamento entre MAMCONTROL e id na tabela `users` do equipamento
// =============================================================================
//
// REGRA DE PRODUÇÃO (compatível com Comunicador legado):
//   O `id` do usuário no equipamento Control iD é a MATRÍCULA (registration_number)
//   do MAMCONTROL. Toda a lógica do autorizador busca por registration_number.
//
// Fallback (sem matrícula):
//   • Pessoa → usa persons.id (autoincrement). Convivem porque persons.id é
//     numericamente pequeno e dificilmente colide com matrículas reais.
//   • Visitante → usa visitors.id + VISITOR_ID_OFFSET (1 bilhão) para garantir
//     que NÃO colida com persons.id nem com matrículas existentes.
//
// Equipamentos em produção (cadastrados pelo Comunicador) já vêm com matrícula.
// Migrar pro Push não duplica nada: `create_or_modify_objects {id: matrícula}`
// apenas ATUALIZA o registro já existente no equipamento.
// =============================================================================

export const VISITOR_ID_OFFSET = 1_000_000_000;

/**
 * @param {'person'|'visitor'} type
 * @param {number|string} internalId
 * @param {string|number|null|undefined} registrationNumber
 * @returns {number} id a usar no equipamento
 */
export function toDeviceUserId(type, internalId, registrationNumber) {
  // 1. PREFERIR matrícula (compatibilidade com cadastros existentes em produção)
  if (registrationNumber !== null && registrationNumber !== undefined && registrationNumber !== '') {
    const onlyDigits = String(registrationNumber).replace(/\D/g, '');
    const matricula = parseInt(onlyDigits, 10);
    if (!Number.isNaN(matricula) && matricula > 0) return matricula;
  }

  // 2. FALLBACK por id interno (com offset para visitors evitarem colisão)
  const id = parseInt(internalId, 10);
  if (Number.isNaN(id) || id < 0) {
    throw new Error(`deviceUserId: id interno inválido (${internalId})`);
  }
  if (type === 'visitor') return id + VISITOR_ID_OFFSET;
  if (type === 'person')  return id;
  throw new Error(`deviceUserId: type desconhecido (${type})`);
}

/**
 * Identifica se um user_id vindo do equipamento é o fallback de visitor (≥ offset).
 * Quando isso acontece, é seguro chamar o autorizador com `{type:'visitor',
 * id: deviceUserId - OFFSET}`. Senão, o user_id é matrícula (ou persons.id
 * raro) e o autorizador resolve pelo lookup normal por registration_number.
 *
 * @param {number|string} deviceUserId
 * @returns {{ isVisitorFallback: boolean, visitorInternalId: number|null }}
 */
export function classifyDeviceUserId(deviceUserId) {
  const n = parseInt(deviceUserId, 10);
  if (!Number.isNaN(n) && n >= VISITOR_ID_OFFSET) {
    return { isVisitorFallback: true, visitorInternalId: n - VISITOR_ID_OFFSET };
  }
  return { isVisitorFallback: false, visitorInternalId: null };
}

// Cache em memória de acessos aguardando giro físico (IDBlock Next).
//
// Quando o autorizador libera um acesso pra catraca (catra both), guardamos
// {tenantId, deviceId, userId} aqui. Quando equip notifica o giro
// (/api/notifications/catra_event), recuperamos o userId pra logar ENTRY/EXIT.
//
// TTL 30s — se pessoa desistir de girar, expira e próxima identificação
// reseta. Em memória basta pra esse caso (volatil é OK, pior caso = log de
// acesso sem direção, que continua sendo registrado pelo autorizador).

const TTL_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

const pendentes = new Map(); // key = `${tenantId}:${deviceId}` → { userId, ts }

function makeKey(tenantId, deviceId) {
  return `${tenantId}:${deviceId}`;
}

export function setAcessoPendente(tenantId, deviceId, userId) {
  if (!tenantId || !deviceId || !userId) return;
  pendentes.set(makeKey(tenantId, deviceId), { userId, ts: Date.now() });
}

export function popAcessoPendente(tenantId, deviceId) {
  const key = makeKey(tenantId, deviceId);
  const entry = pendentes.get(key);
  if (!entry) return null;
  pendentes.delete(key);
  if (Date.now() - entry.ts > TTL_MS) return null;  // expirado
  return entry.userId;
}

export function getPendentesSnapshot() {
  const out = {};
  for (const [k, v] of pendentes.entries()) {
    out[k] = { userId: v.userId, ageMs: Date.now() - v.ts };
  }
  return out;
}

// Sweep periódico — remove órfãos vencidos pra memória não crescer.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendentes.entries()) {
    if (now - v.ts > TTL_MS) pendentes.delete(k);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

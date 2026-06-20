// Circuit breaker por device. Isolamento: 1 device problemático não afeta os outros.
// Estados: closed (normal) | open (bloqueado) | half-open (testando recuperação).

import logger from './logger.js';

const FAILURE_THRESHOLD = 5;        // 5 erros consecutivos abre o circuito
const RECOVERY_TIMEOUT_MS = 60_000; // após 60s, tenta novamente (half-open)
const HALF_OPEN_MAX_PROBES = 1;     // apenas 1 tentativa em half-open

const state = new Map(); // deviceId → { failures, openedAt, halfOpenProbes }

export function isCircuitOpen(deviceId) {
  const s = state.get(deviceId);
  if (!s) return false;
  if (!s.openedAt) return false;

  // Passou o tempo de cooldown? Entra em half-open
  if (Date.now() - s.openedAt > RECOVERY_TIMEOUT_MS) {
    if (s.halfOpenProbes < HALF_OPEN_MAX_PROBES) {
      s.halfOpenProbes++;
      return false; // permite passar (probe)
    }
    return true;
  }

  return true;
}

export function recordSuccess(deviceId) {
  if (state.has(deviceId)) {
    logger.info('circuit_recovered', { deviceId });
    state.delete(deviceId);
  }
}

export function recordFailure(deviceId, error) {
  const s = state.get(deviceId) || { failures: 0, openedAt: null, halfOpenProbes: 0 };
  s.failures++;

  if (s.failures >= FAILURE_THRESHOLD && !s.openedAt) {
    s.openedAt = Date.now();
    s.halfOpenProbes = 0;
    logger.warn('circuit_opened', { deviceId, failures: s.failures, error });
  }

  state.set(deviceId, s);
}

export function forceClose(deviceId) {
  state.delete(deviceId);
  logger.info('circuit_force_close', { deviceId });
}

export function getCircuitSnapshot() {
  const snapshot = {};
  for (const [deviceId, s] of state.entries()) {
    snapshot[deviceId] = {
      failures: s.failures,
      open: !!s.openedAt,
      openedAt: s.openedAt,
      msUntilHalfOpen: s.openedAt ? Math.max(0, RECOVERY_TIMEOUT_MS - (Date.now() - s.openedAt)) : 0,
    };
  }
  return snapshot;
}

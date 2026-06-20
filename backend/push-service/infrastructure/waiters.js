// Long-polling waiter — mantém Promises pendentes esperando comando aparecer.
// In-memory por design. Quando passar de ~5k devices simultâneos, trocar por Redis pub/sub.

import logger from './logger.js';

// deviceId → array de { resolve, timer }
const waiters = new Map();

/**
 * Bloqueia por até timeoutMs aguardando alguém chamar wakeUp(deviceId).
 * Retorna true se acordou por wake, false se estourou timeout.
 */
export function waitFor(deviceId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter(deviceId, resolve);
      resolve(false);
    }, timeoutMs);

    const waiter = { resolve, timer };
    if (!waiters.has(deviceId)) waiters.set(deviceId, []);
    waiters.get(deviceId).push(waiter);
  });
}

/**
 * Acorda o próximo long-poll daquele device (FIFO).
 * Se ninguém estiver aguardando, é no-op.
 */
export function wakeUp(deviceId) {
  const list = waiters.get(deviceId);
  if (!list?.length) return false;

  const waiter = list.shift();
  clearTimeout(waiter.timer);
  waiter.resolve(true);

  if (list.length === 0) waiters.delete(deviceId);
  return true;
}

/**
 * Acorda TODOS aguardando aquele device (em casos especiais — reboot, etc.).
 */
export function wakeAll(deviceId) {
  const list = waiters.get(deviceId);
  if (!list?.length) return 0;

  const n = list.length;
  for (const w of list) {
    clearTimeout(w.timer);
    w.resolve(true);
  }
  waiters.delete(deviceId);
  return n;
}

function removeWaiter(deviceId, resolve) {
  const list = waiters.get(deviceId);
  if (!list) return;
  const idx = list.findIndex(w => w.resolve === resolve);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (list.length === 0) waiters.delete(deviceId);
  }
}

/**
 * Snapshot para /admin/metrics.
 */
export function getWaitersSnapshot() {
  const snapshot = {};
  for (const [deviceId, list] of waiters.entries()) {
    snapshot[deviceId] = list.length;
  }
  return snapshot;
}

export function getTotalWaiters() {
  let total = 0;
  for (const list of waiters.values()) total += list.length;
  return total;
}

// Autenticação de equipamento via X-Device-Secret (header) ou query ?token=
// Estratégia: cache em memória (deviceId+token → tenantId+equip), TTL 5min.

import { listTenants, getTenantDb } from './tenantDb.js';
import logger from './logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key = `${deviceId}:${token}` → { tenantId, equipment, expiresAt }

// Modo "trust LAN" — para teste local, aceita request sem token se:
//   - PUSH_TRUST_LAN=1 estiver setado
//   - IP de origem é private/LAN
//   - equipamento existe ativo com push_enabled=1
// Em produção (VPS): manter PUSH_TRUST_LAN ausente — segurança vem de HTTPS + nginx.
const TRUST_LAN = process.env.PUSH_TRUST_LAN === '1';

function isLanIp(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1'
    || /^10\./.test(clean)
    || /^192\.168\./.test(clean)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(clean);
}

/**
 * "Trust" extra: request CHEGOU pelo socket loopback (= via nginx local).
 * Em produção atrás de nginx, req.ip vem do X-Forwarded-For (IP público do
 * equipamento atrás do NAT do cliente), então isLanIp(req.ip) falha mesmo
 * com PUSH_TRUST_LAN=1. Mas o socket TCP é sempre 127.0.0.1.
 *
 * O nginx é o gatekeeper — chega no Push só quem nginx deixou passar.
 * Combinado com "equip deve existir + push_enabled=1", é suficiente pra teste/prod.
 */
function isLoopbackSocket(req) {
  const sock = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return sock === '127.0.0.1' || sock === '::1';
}

/**
 * Tenta autenticar o equipamento varrendo tenants até achar.
 * Em produção com muitos tenants, isso pode ficar lento — solução: JWT
 * com tenantId embutido. Mas para <100 tenants, varrer é trivial (~10ms).
 */
export async function authenticateDevice(req) {
  const deviceId = req.query.deviceId || req.body?.device_id;
  if (!deviceId) return null;

  const token = req.headers['x-device-secret']
    || req.query.token
    || req.headers['authorization']?.replace(/^Bearer /i, '');

  const remoteIp = req.ip || req.connection?.remoteAddress || '';

  // Modo trust-LAN: busca apenas por validador, ignora token.
  // Aceita se:
  //   - PUSH_TRUST_LAN=1 + req.ip é LAN  (DEV direto sem nginx), OU
  //   - socket vem de loopback (= via nginx local em PROD: nginx é o gatekeeper)
  const lanOk = TRUST_LAN && isLanIp(remoteIp);
  const nginxOk = isLoopbackSocket(req);
  if (!token && (lanOk || nginxOk)) {
    const cached = cache.get(`lan:${deviceId}`);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const tenants = await listTenants();
    for (const tenantId of tenants) {
      try {
        const db = await getTenantDb(tenantId);
        const equip = await db.get(
          `SELECT id, name, validador, push_enabled, push_secret, modelo, ip_address
           FROM equipments
           WHERE validador = ? AND active = 1 AND push_enabled = 1`,
          [deviceId]
        );
        if (equip) {
          const auth = {
            tenantId,
            deviceId: equip.validador,
            equipment: equip,
            expiresAt: Date.now() + CACHE_TTL_MS,
            trustLan: true,
          };
          cache.set(`lan:${deviceId}`, auth);
          logger.info(nginxOk ? 'auth_trust_loopback' : 'auth_trust_lan',
            { deviceId, tenantId, remoteIp });
          return auth;
        }
      } catch (err) {
        logger.warn('auth_tenant_lookup_failed', { tenantId, error: err.message });
      }
    }
    logger.warn('auth_trust_lan_no_equip', { deviceId, remoteIp });
    return null;
  }

  if (!token) {
    logger.warn('auth_no_token', {
      deviceId,
      query: req.query,
      url: req.originalUrl,
    });
    return null;
  }

  const cacheKey = `${deviceId}:${token}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // Cache miss — busca em todos os tenants
  const tenants = await listTenants();
  for (const tenantId of tenants) {
    try {
      const db = await getTenantDb(tenantId);
      const equip = await db.get(
        `SELECT id, name, validador, push_enabled, push_secret, modelo, ip_address
         FROM equipments
         WHERE validador = ? AND push_secret = ? AND active = 1`,
        [deviceId, token]
      );

      if (equip && equip.push_enabled === 1) {
        const auth = {
          tenantId,
          deviceId: equip.validador,
          equipment: equip,
          expiresAt: Date.now() + CACHE_TTL_MS,
        };
        cache.set(cacheKey, auth);
        return auth;
      }
    } catch (err) {
      logger.warn('auth_tenant_lookup_failed', { tenantId, error: err.message });
    }
  }

  logger.warn('auth_failed', {
    deviceId,
    tokenPrefix: String(token).slice(0, 12),
    url: req.originalUrl,
  });
  return null;
}

export function invalidateAuthCache(deviceId) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${deviceId}:`)) cache.delete(key);
  }
}

export function clearAllAuth() {
  cache.clear();
}

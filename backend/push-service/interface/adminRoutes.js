// Rotas administrativas / observabilidade.
// Aceitas só de loopback OU com header X-Admin-Token (configurar em prod).

import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import os from 'os';
import { listTenants, getTenantDb, getOpenTenants } from '../infrastructure/tenantDb.js';
import { getDeviceStats } from '../infrastructure/outboxRepo.js';
import { getTotalWaiters, getWaitersSnapshot } from '../infrastructure/waiters.js';
import { getCircuitSnapshot, forceClose } from '../infrastructure/circuitBreaker.js';
import { invalidateAuthCache } from '../infrastructure/deviceAuth.js';
import logger from '../infrastructure/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();
router.use(express.json());

const ADMIN_TOKEN = process.env.PUSH_ADMIN_TOKEN || '';

// Considera "online" um equipamento que pingou nos últimos N segundos
const ONLINE_WINDOW_SEC = parseInt(process.env.PUSH_ONLINE_WINDOW_SEC || '30', 10);

router.use((req, res, next) => {
  // socketIp = IP da CONEXÃO TCP (sempre 127.0.0.1 quando vem do nginx local).
  //   Não confunde com req.ip — esse, com trust proxy, vem do X-Forwarded-For
  //   (= IP público do cliente), que é o que queremos bloquear em prod.
  // Quem decide "este cliente real pode acessar" é o nginx (allow/deny no path).
  const socketIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isLocalSocket = socketIp === '127.0.0.1' || socketIp === '::1'
    || /^192\.168\./.test(socketIp) || /^10\./.test(socketIp);
  const token = req.headers['x-admin-token'];
  if (isLocalSocket) return next();
  if (ADMIN_TOKEN && token === ADMIN_TOKEN) return next();
  return res.status(403).json({ error: 'forbidden' });
});

// GET /admin/metrics  → snapshot geral
router.get('/metrics', async (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    waiters: {
      total: getTotalWaiters(),
      perDevice: getWaitersSnapshot(),
    },
    circuits: getCircuitSnapshot(),
    openTenants: getOpenTenants(),
  });
});

// GET /admin/devices?tenantId=...  → lista equipamentos do tenant + stats
router.get('/devices', async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  try {
    const db = await getTenantDb(tenantId);
    const devices = await db.all(
      `SELECT id, name, validador, ip_address, modelo, active,
              push_enabled, push_last_seen
       FROM equipments
       ORDER BY id`
    );

    const enriched = await Promise.all(
      devices.map(async (d) => ({
        ...d,
        stats: d.validador ? await getDeviceStats(tenantId, d.validador) : null,
      }))
    );

    res.json({ tenantId, devices: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/queue?tenantId=...&deviceId=...&status=...&limit=50
router.get('/queue', async (req, res) => {
  const { tenantId, deviceId, status, limit = 50 } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  try {
    const db = await getTenantDb(tenantId);
    const where = [];
    const params = [];
    if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
    if (status)   { where.push('status = ?');    params.push(status); }

    const sql = `SELECT id, device_id, endpoint, status, attempts, last_error,
                        created_at, picked_at, completed_at, origin
                 FROM push_outbox
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY id DESC LIMIT ?`;

    const rows = await db.all(sql, [...params, parseInt(limit, 10)]);
    res.json({ tenantId, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/circuit/close
// Body: { deviceId }
router.post('/circuit/close', (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  forceClose(deviceId);
  res.json({ ok: true });
});

// GET /admin/server-info → IPs LAN do servidor (usado como default no provisioning)
//   • lista IPs IPv4 não-loopback de todas as interfaces (Wi-Fi, Ethernet, etc).
//   • exclui loopback (127.x), VPNs comuns (vEthernet) e link-local (169.x).
//   • o primeiro IP "192.168/16" ou "10/8" costuma ser o que o equipamento usa.
router.get('/server-info', (req, res) => {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\./.test(a.address)) continue;       // APIPA
      if (/Loopback/i.test(name)) continue;
      ips.push({ iface: name, ip: a.address });
    }
  }
  const score = (ip) =>
    /^192\.168\./.test(ip) ? 3 :
    /^10\./.test(ip) ? 2 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 1;
  ips.sort((a, b) => score(b.ip) - score(a.ip));
  res.json({
    hostname: os.hostname(),
    pushPort: parseInt(process.env.PUSH_PORT || '3001', 10),
    ips,
    suggestedHost: ips[0]?.ip || null,
  });
});

// GET /admin/tenants
router.get('/tenants', async (req, res) => {
  try {
    const all = await listTenants();
    res.json({ tenants: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/overview → snapshot agregado pra dashboard
//  • lista todos tenants + equipamentos
//  • marca online (push_last_seen <= ONLINE_WINDOW_SEC) ou offline
//  • inclui contagens push_outbox
router.get('/overview', async (req, res) => {
  try {
    const tenants = await listTenants();
    const circuits = getCircuitSnapshot();
    const waiters = getWaitersSnapshot();

    let totals = { equipments: 0, online: 0, offline: 0, push_enabled: 0,
                   pending: 0, in_flight: 0, error: 0, dead: 0 };
    const rows = [];

    for (const tenantId of tenants) {
      let db;
      try { db = await getTenantDb(tenantId); } catch { continue; }
      let equips;
      try {
        equips = await db.all(
          `SELECT id, name, validador, ip_address, modelo, active,
                  push_enabled, push_last_seen
           FROM equipments`
        );
      } catch { continue; }
      for (const e of equips) {
        totals.equipments++;
        if (e.push_enabled) totals.push_enabled++;
        const lastSeenMs = e.push_last_seen ? new Date(e.push_last_seen + 'Z').getTime() : 0;
        const seenAgoSec = lastSeenMs ? Math.floor((Date.now() - lastSeenMs) / 1000) : null;
        const online = seenAgoSec !== null && seenAgoSec <= ONLINE_WINDOW_SEC;
        if (e.push_enabled) {
          if (online) totals.online++; else totals.offline++;
        }
        let stats = { pending: 0, in_flight: 0, done: 0, error: 0, dead: 0 };
        try {
          if (e.validador) stats = { ...stats, ...(await getDeviceStats(tenantId, e.validador)) };
        } catch {}
        totals.pending += stats.pending;
        totals.in_flight += stats.in_flight;
        totals.error += stats.error;
        totals.dead += stats.dead;
        const circuit = e.validador ? (circuits[e.validador] || null) : null;
        const waiting = e.validador ? (waiters[e.validador] || 0) : 0;
        rows.push({
          tenantId,
          id: e.id, name: e.name, validador: e.validador,
          ip_address: e.ip_address, modelo: e.modelo,
          active: !!e.active, push_enabled: !!e.push_enabled,
          push_last_seen: e.push_last_seen,
          seen_ago_sec: seenAgoSec, online,
          stats, circuit, waiting,
        });
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      totals,
      devices: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/logs?lines=100 → últimas N linhas do push.log
router.get('/logs', async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines || '100', 10), 1000);
  try {
    const { readFile } = await import('fs/promises');
    const logPath = resolve(__dirname, '..', '..', 'logs', 'push.log');
    const buf = await readFile(logPath, 'utf-8').catch(() => '');
    const all = buf.split(/\r?\n/).filter(Boolean);
    res.json({ lines: all.slice(-lines) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/devices/:validador/reprovision
//   body: { ip, login?, password?, server_host?, server_port?, server_id? }
// Roda tests/provisioning.js como subprocesso, retorna stdout.
router.post('/devices/:validador/reprovision', async (req, res) => {
  const { validador } = req.params;
  const { ip, login = 'admin', password = 'admin',
          server_host, server_port = '3001',
          server_id = '5', server_name = 'mam-push' } = req.body || {};

  if (!ip)          return res.status(400).json({ error: 'ip required' });
  if (!server_host) return res.status(400).json({ error: 'server_host required' });

  const provisioningPath = resolve(__dirname, '..', '..', '..', '..',
    'PUSH_SERVICE_HANDOFF', 'tests', 'provisioning.js');

  const args = [
    provisioningPath,
    '--ip', ip,
    '--login', login,
    '--password', password,
    '--server-host', server_host,
    '--server-port', String(server_port),
    '--server-id', String(server_id),
    '--server-name', server_name,
  ];

  logger.info('reprovision_start', { validador, ip, server_host });

  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
  child.on('close', (code) => {
    clearTimeout(timeout);
    invalidateAuthCache(validador); // permite re-auth com nova config
    logger.info('reprovision_done', { validador, code, stdoutLen: stdout.length });
    res.json({ ok: code === 0, exitCode: code, stdout, stderr });
  });
});

// POST /admin/devices/:validador/enable-push
//   body: { tenantId }   → seta push_enabled=1
router.post('/devices/:validador/enable-push', async (req, res) => {
  const { validador } = req.params;
  const { tenantId } = req.body || {};
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const db = await getTenantDb(tenantId);
    const r = await db.run(
      `UPDATE equipments SET push_enabled = 1 WHERE validador = ?`,
      [validador]
    );
    invalidateAuthCache(validador);
    res.json({ ok: r.changes > 0, changes: r.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/devices/:validador/disable-push
router.post('/devices/:validador/disable-push', async (req, res) => {
  const { validador } = req.params;
  const { tenantId } = req.body || {};
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const db = await getTenantDb(tenantId);
    const r = await db.run(
      `UPDATE equipments SET push_enabled = 0 WHERE validador = ?`,
      [validador]
    );
    invalidateAuthCache(validador);
    res.json({ ok: r.changes > 0, changes: r.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/queue/:id/retry → manda linha "dead"/"error" voltar pra pending
router.post('/queue/:id/retry', async (req, res) => {
  const { tenantId } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const db = await getTenantDb(tenantId);
    const r = await db.run(
      `UPDATE push_outbox SET status='pending', attempts=0, last_error=NULL, uuid=NULL
       WHERE id = ?`,
      [id]
    );
    res.json({ ok: r.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/queue/clear-dead → remove todas linhas dead/error de um tenant
router.post('/queue/clear-dead', async (req, res) => {
  const { tenantId } = req.body || {};
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const db = await getTenantDb(tenantId);
    const r = await db.run(`DELETE FROM push_outbox WHERE status IN ('dead','error')`);
    res.json({ ok: true, deleted: r.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

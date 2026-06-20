// Conexões SQLite por tenant — POOL PRÓPRIO do Push Service.
// NÃO importa a conexão do backend antigo. Cada processo tem seu próprio cache.
// O arquivo é o mesmo no disco — WAL + busy_timeout=5000 permitem coexistência.

import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Caminho do storage. Em produção: passar via DATABASE_STORAGE no .env do push.
// Default: tenta achar baseado em ../../database/tenants relativo a este arquivo.
const BASE_PATH = process.env.DATABASE_STORAGE
  || join(__dirname, '..', '..', 'database', 'tenants');

const connections = new Map();   // tenantId → dbAsync
const initialized = new Set();   // tenants já com PRAGMAs aplicados
const migrated = new Set();      // tenants já com schema push (idempotente)

export async function initTenantManager() {
  try {
    await fs.access(BASE_PATH);
    logger.info('tenant_storage_ok', { path: BASE_PATH });
  } catch {
    throw new Error(`tenant storage não existe: ${BASE_PATH}. Configure DATABASE_STORAGE.`);
  }
}

export async function listTenants() {
  const files = await fs.readdir(BASE_PATH);
  return files
    .filter(f => f.startsWith('tenant_') && f.endsWith('.db'))
    .map(f => f.replace(/^tenant_/, '').replace(/\.db$/, ''));
}

export async function getTenantDb(tenantId) {
  if (!tenantId) throw new Error('tenantId obrigatório');

  if (connections.has(tenantId)) {
    return connections.get(tenantId);
  }

  const dbPath = join(BASE_PATH, `tenant_${tenantId}.db`);
  try {
    await fs.access(dbPath);
  } catch {
    throw new Error(`tenant ${tenantId} não existe (arquivo: ${dbPath})`);
  }

  const db = new sqlite3.Database(dbPath);

  const runPragma = (sql) => new Promise((resolve, reject) => {
    db.run(sql, (err) => err ? reject(err) : resolve());
  });

  // PRAGMAs IDÊNTICOS ao backend antigo (src/config/database.js) — essencial para coexistência.
  await runPragma('PRAGMA encoding = "UTF-8"');
  await runPragma('PRAGMA journal_mode=WAL');
  await runPragma('PRAGMA synchronous=NORMAL');
  await runPragma('PRAGMA cache_size=-32000');         // 32MB (Push usa menos que API)
  await runPragma('PRAGMA temp_store=memory');
  await runPragma('PRAGMA mmap_size=134217728');       // 128MB
  await runPragma('PRAGMA busy_timeout=5000');         // espera lock por 5s

  const runWithLastID = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params || [], function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

  const dbAsync = {
    get: promisify(db.get.bind(db)),
    all: promisify(db.all.bind(db)),
    run: runWithLastID,
    exec: promisify(db.exec.bind(db)),
    close: promisify(db.close.bind(db)),
    _raw: db,
  };

  connections.set(tenantId, dbAsync);
  logger.info('tenant_db_opened', { tenantId });

  // Garante schema push (tabelas, ALTERs em equipments) na PRIMEIRA abertura.
  // Cobre o caso de tenant novo criado depois do startup do Push.
  // Import dinâmico evita ciclo (migrations.js importa getTenantDb).
  if (!migrated.has(tenantId)) {
    migrated.add(tenantId);
    try {
      const { runMigrationsForTenant } = await import('./migrations.js');
      await runMigrationsForTenant(tenantId);
    } catch (err) {
      logger.warn('on_demand_migration_failed', { tenantId, error: err.message });
    }
  }

  return dbAsync;
}

export function getOpenTenants() {
  return Array.from(connections.keys());
}

export async function closeAll() {
  for (const [tenantId, db] of connections.entries()) {
    try { await db.close(); } catch {}
    connections.delete(tenantId);
  }
}

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import fs from 'fs';

const tenantId = process.argv[2] || 'haofices';
const candidates = [
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`),
  `C:/ProgramData/AcessControl/backend/database/tenants/tenant_${tenantId}.db`,
];

const dbPath = candidates.find(p => fs.existsSync(p));
if (!dbPath) {
  console.error('DB não encontrado:', candidates);
  process.exit(1);
}

console.log('DB:', dbPath);
const db = new Database(dbPath, { readonly: true });

const cols = db.prepare('PRAGMA table_info(equipments)').all().map(c => c.name);
console.log('Colunas push/online:', cols.filter(c => /push|online|last_connection/i.test(c)));

const hasOutbox = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_outbox'").get();
console.log('Tabela push_outbox:', hasOutbox);

const eq = db.prepare(`
  SELECT id, name, validador, ip_address, active, online, last_connection,
         push_enabled, push_last_seen, tipo, modelo
  FROM equipments WHERE active = 1 ORDER BY id
`).all();

console.log(`\nEquipamentos ativos: ${eq.length}`);
let pushOn = 0, onlineCol = 0, pushSeen = 0;
for (const e of eq) {
  if (e.push_enabled === 1) pushOn++;
  if (e.online === 1) onlineCol++;
  if (e.push_last_seen) pushSeen++;
  console.log([
    `id=${e.id}`,
    e.name?.slice(0, 40),
    `validador=${e.validador}`,
    `push_enabled=${e.push_enabled ?? 'null'}`,
    `online=${e.online}`,
    `push_last_seen=${e.push_last_seen || '-'}`,
    `last_connection=${e.last_connection || '-'}`,
    `ip=${e.ip_address || '-'}`,
  ].join(' | '));
}

console.log('\nResumo:');
console.log(`  push_enabled=1: ${pushOn}`);
console.log(`  online=1 (coluna legada): ${onlineCol}`);
console.log(`  push_last_seen preenchido: ${pushSeen}`);

if (hasOutbox) {
  const pending = db.prepare("SELECT COUNT(*) as n FROM push_outbox WHERE status='pending'").get()?.n ?? 0;
  console.log(`  push_outbox pending: ${pending}`);
}

db.close();

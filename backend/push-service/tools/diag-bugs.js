import { getTenantDb } from '../infrastructure/tenantDb.js';
const tenant = process.argv[2] || 'pushtest';
const db = await getTenantDb(tenant);

console.log('=== access_tasks CHECK constraint ===');
const t = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='access_tasks'`);
console.log(t?.sql || '(no table)');

console.log('\n=== access_tasks recentes ===');
const tasks = await db.all(`SELECT id, task_type, status, resolved, equip_validator, created_at FROM access_tasks ORDER BY id DESC LIMIT 10`);
console.table(tasks);

console.log('\n=== push_outbox recentes ===');
const pb = await db.all(`SELECT id, device_id, endpoint, status, attempts, last_error, origin, created_at FROM push_outbox ORDER BY id DESC LIMIT 10`);
console.table(pb);

console.log('\n=== visitors (5 últimos) ===');
const v = await db.all(`SELECT id, name, registration_number, status FROM visitors ORDER BY id DESC LIMIT 5`);
console.table(v);

console.log('\n=== equip_sync_queue ===');
try {
  const q = await db.all(`SELECT * FROM equip_sync_queue ORDER BY id DESC LIMIT 5`);
  console.table(q);
} catch (e) { console.log('(no table):', e.message); }
process.exit(0);

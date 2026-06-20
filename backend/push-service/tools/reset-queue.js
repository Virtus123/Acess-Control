// Reseta todas as linhas in_flight/error/dead → pending no tenant indicado.
import { getTenantDb } from '../infrastructure/tenantDb.js';
const tenant = process.argv[2] || 'pushtest';
const db = await getTenantDb(tenant);
const r1 = await db.run(`UPDATE push_outbox SET status='pending', uuid=NULL, attempts=0, last_error=NULL WHERE status IN ('in_flight','error')`);
const r2 = await db.run(`DELETE FROM push_outbox WHERE status='dead'`);
console.log(`reset: ${r1.changes} linhas in_flight/error → pending`);
console.log(`deleted: ${r2.changes} linhas dead`);
process.exit(0);

import { getTenantDb, listTenants } from '../infrastructure/tenantDb.js';

for (const t of await listTenants()) {
  const db = await getTenantDb(t);
  try {
    const rows = await db.all(`SELECT id, tenant_id, name, access_type, schedule_type, active, persons, equipments FROM access_rules`);
    console.log(`\n=== tenant ${t} (${rows.length} regras) ===`);
    if (rows.length) console.table(rows);
  } catch (e) {
    console.log(`[${t}] sem access_rules: ${e.message}`);
  }
}
process.exit(0);

// Adiciona colunas que o autorizadorService espera em access_log.
import { getTenantDb, listTenants } from '../infrastructure/tenantDb.js';

const tenants = await listTenants();
for (const t of tenants) {
  const db = await getTenantDb(t);
  const cols = await db.all(`PRAGMA table_info('access_log')`);
  const have = new Set(cols.map(c => c.name));
  const wanted = [
    ['uhf_tag',     "ALTER TABLE access_log ADD COLUMN uhf_tag TEXT"],
    ['user_name',   "ALTER TABLE access_log ADD COLUMN user_name TEXT"],
    ['device_name', "ALTER TABLE access_log ADD COLUMN device_name TEXT"],
    ['portal_id',   "ALTER TABLE access_log ADD COLUMN portal_id INTEGER"],
    ['photo_url',   "ALTER TABLE access_log ADD COLUMN photo_url TEXT"],
    ['direction',   "ALTER TABLE access_log ADD COLUMN direction TEXT"],
    ['matricula',   "ALTER TABLE access_log ADD COLUMN matricula TEXT"],
  ];
  for (const [name, sql] of wanted) {
    if (!have.has(name)) {
      try {
        await db.exec(sql);
        console.log(`[${t}] + ${name}`);
      } catch (e) {
        if (!/duplicate column/i.test(e.message)) {
          console.warn(`[${t}] x ${name}: ${e.message}`);
        }
      }
    }
  }
}
console.log('done.');
process.exit(0);

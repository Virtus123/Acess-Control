// Cadastra pessoa de teste pra autorização online.
// node push-service/tools/insert-test-person.js <tenant> <reg_number> <name>
import { getTenantDb } from '../infrastructure/tenantDb.js';

const [, , tenant = 'pushtest', reg = '1001', name = 'Vitor Teste'] = process.argv;

const db = await getTenantDb(tenant);

// Limpar versões anteriores com mesma matrícula (re-execução segura)
await db.run(`DELETE FROM persons WHERE registration_number = ?`, [reg]);

const r = await db.run(
  `INSERT INTO persons (name, registration_number, status, created_at, updated_at)
   VALUES (?, ?, 'active', datetime('now'), datetime('now'))`,
  [name, reg]
);
console.log(`✅ persons.id=${r.lastID} matricula=${reg} name="${name}"`);

const back = await db.get('SELECT id, name, registration_number, status FROM persons WHERE id = ?', [r.lastID]);
console.log('   ', back);
process.exit(0);

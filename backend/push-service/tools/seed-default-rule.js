// Cria regra de acesso "permitir tudo 24/7" no tenant + completa colunas access_log
import { getTenantDb } from '../infrastructure/tenantDb.js';

const [, , tenant = 'pushtest'] = process.argv;
const db = await getTenantDb(tenant);

// 1. Garantir colunas extras em access_log que o autorizador usa
const logCols = new Set((await db.all(`PRAGMA table_info('access_log')`)).map(c => c.name));
for (const [name, sql] of [
  ['source', "ALTER TABLE access_log ADD COLUMN source TEXT"],
]) {
  if (!logCols.has(name)) {
    try { await db.exec(sql); console.log(`access_log + ${name}`); }
    catch (e) { if (!/duplicate/i.test(e.message)) console.warn(e.message); }
  }
}

// 2. Inspecionar schema de access_rules
const ruleCols = await db.all(`PRAGMA table_info('access_rules')`);
console.log('\naccess_rules schema:');
console.table(ruleCols.map(c => ({ name: c.name, type: c.type, notnull: c.notnull })));

// 3. Limpar regra antiga de mesmo nome (reentrante)
await db.run(`DELETE FROM access_rules WHERE name = ?`, ['LIBERA_TUDO_TESTE']);

// 4. Inserir nova regra ALLOW-ALL ativa
// Strings de horário cobertura 24/7 — formato pode variar; tento campos comuns.
const colNames = ruleCols.map(c => c.name);
const fields = [];
const vals = [];
const push = (n, v) => { if (colNames.includes(n)) { fields.push(n); vals.push(v); } };
push('name', 'LIBERA_TUDO_TESTE');
push('description', 'Regra criada para teste do Push Service — autoriza qualquer pessoa em qualquer horário.');
push('active', 1);
push('enabled', 1);
push('allow', 1);
push('priority', 100);
push('rule_type', 'allow');
push('type', 'allow');
push('horario_inicio', '00:00');
push('horario_fim', '23:59');
push('start_time', '00:00');
push('end_time', '23:59');
push('dias_semana', '1,2,3,4,5,6,7');
push('weekdays', '1,2,3,4,5,6,7');
push('created_at', new Date().toISOString());
push('updated_at', new Date().toISOString());
const placeholders = fields.map(() => '?').join(', ');
const sql = `INSERT INTO access_rules (${fields.join(', ')}) VALUES (${placeholders})`;
console.log('\nSQL:', sql);
const r = await db.run(sql, vals);
console.log(`\n✅ access_rules.id=${r.lastID} (LIBERA_TUDO_TESTE)`);
process.exit(0);

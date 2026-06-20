/**
 * Análise profunda — cotas vs ocupação, duplicatas, equipamentos.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const tenantId = process.argv[2] || 'haofices';
const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`);
const db = new Database(dbPath, { readonly: true });

const parking = db.prepare('SELECT id, name, total_spots, empresas FROM parkings WHERE id = 1').get();
const empresas = JSON.parse(parking?.empresas || '[]');

console.log('\n=== COTAS vs OCUPAÇÃO (empresas estouradas) ===');
const over = [];
for (const e of empresas) {
  const count = db.prepare(`
    SELECT COUNT(*) as n FROM vehicles
    WHERE status = 'active' AND parking_id = 1 AND company_id = ?
  `).get(e.empresaId)?.n || 0;
  if (count > e.vagas) {
    over.push({ empresaId: e.empresaId, limite: e.vagas, ocupados: count, excesso: count - e.vagas });
  }
}
console.log(`Empresas com cota estourada: ${over.length} de ${empresas.length}`);
over.sort((a, b) => b.excesso - a.excesso).slice(0, 15).forEach(o => {
  const c = db.prepare('SELECT corporate_name, trading_name FROM companies WHERE id = ?').get(o.empresaId);
  console.log(`  empresa ${o.empresaId} (${c?.trading_name || c?.corporate_name}): limite=${o.limite} ocupados=${o.ocupados} (+${o.excesso})`);
});

console.log('\n=== PESSOAS com 2+ veículos ACTIVE ===');
const multi = db.prepare(`
  SELECT person_id, COUNT(*) as n FROM vehicles WHERE status = 'active' GROUP BY person_id HAVING n > 1
`).all();
console.log(`Pessoas com mais de 1 veículo active: ${multi.length}`);
multi.slice(0, 10).forEach(m => {
  const p = db.prepare('SELECT name FROM persons WHERE id = ?').get(m.person_id);
  const plates = db.prepare('SELECT plate, license_plate FROM vehicles WHERE person_id = ? AND status = ?').all(m.person_id, 'active');
  console.log(`  ${p?.name}: ${m.n} veículos — ${plates.map(v => v.plate || v.license_plate).join(', ')}`);
});

console.log('\n=== 23 FANTASMAS (active sem log) — amostra ===');
const ghosts = db.prepare(`
  SELECT v.id, v.plate, v.license_plate, v.company_id, p.name
  FROM vehicles v LEFT JOIN persons p ON p.id = v.person_id
  WHERE v.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM access_log al WHERE al.vehicle_id = v.id)
  LIMIT 25
`).all();
ghosts.forEach(g => console.log(`  id=${g.id} ${g.plate || g.license_plate} company=${g.company_id} ${g.name}`));

console.log('\n=== on_premisse=1 sem veículo active ===');
db.prepare(`
  SELECT p.id, p.name, p.on_premisse, p.exited
  FROM persons p
  WHERE p.on_premisse = 1
    AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = p.id AND v.status = 'active')
  LIMIT 15
`).all().forEach(p => console.log(`  id=${p.id} ${p.name} exited=${p.exited}`));

console.log('\n=== EQUIPAMENTOS estacionamento (todos com flag) ===');
db.prepare(`
  SELECT id, name, tipo, modelo, controla_estacionamento, equipamento_saida, validador
  FROM equipments WHERE controla_estacionamento = 1 OR name LIKE '%ESTAC%' OR name LIKE '%estac%'
`).all().forEach(e => {
  console.log(`  id=${e.id} flag=${e.controla_estacionamento} tipo=${e.tipo} modelo=${e.modelo} saida=${e.equipamento_saida} | ${e.name}`);
});

console.log('\n=== Total spots vs active global ===');
const totalActive = db.prepare("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active' AND parking_id = 1").get().n;
console.log(`Estacionamento capacidade total_spots: ${parking?.total_spots}, active no parking 1: ${totalActive}`);

console.log('\n=== access_log VEHICLE hoje vs active ===');
const logsToday = db.prepare(`
  SELECT COUNT(DISTINCT vehicle_id) as n FROM access_log
  WHERE access_type = 'VEHICLE' AND action = 'ENTRY' AND status = 'SUCCESS'
    AND date(created_at) = date('now')
`).get().n;
console.log(`Entradas VEHICLE distintas hoje: ${logsToday}`);

db.close();

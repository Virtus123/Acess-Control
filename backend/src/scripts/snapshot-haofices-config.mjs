/**
 * Snapshot read-only do tenant haofices (produção local).
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const tenantId = process.argv[2] || 'haofices';
const dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function q(sql, params = []) {
  return db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
}
function one(sql, params = []) {
  return db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

console.log('DB:', dbPath);
console.log('Size MB:', (db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size / 1024 / 1024).toFixed(1));

console.log('\n=== REGRAS ATIVAS ===');
q(`SELECT id, name, access_type, access_target, max_vehicles, parking_type, parkings, equipments, schedule_type
   FROM access_rules WHERE active = 1 ORDER BY id`).forEach(r => {
  console.log(`id=${r.id} target=${r.access_target} max=${r.max_vehicles} type=${r.parking_type} | ${r.name}`);
  console.log(`  parkings=${r.parkings?.slice?.(0,80)}`);
  console.log(`  equipments=${r.equipments?.slice?.(0,120)}`);
});

console.log('\n=== EQUIPAMENTOS (pátio / estacionamento) ===');
q(`SELECT id, name, tipo, modelo, validador, controla_estacionamento, equipamento_saida, active
   FROM equipments
   WHERE controla_estacionamento = 1
      OR UPPER(name) LIKE '%ESTAC%'
      OR UPPER(name) LIKE '%PATIO%'
      OR UPPER(name) LIKE '%PÁTIO%'
      OR modelo LIKE '%Face%'
      OR modelo = 'IDUHF'
   ORDER BY id`).forEach(e => {
  console.log(`id=${e.id} active=${e.active} flag=${e.controla_estacionamento} tipo=${e.tipo} modelo=${e.modelo} saida=${e.equipamento_saida}`);
  console.log(`  ${e.name} | validador=${e.validador}`);
});

console.log('\n=== CATRACAS com flag estacionamento ===');
q(`SELECT id, name, tipo, modelo, controla_estacionamento FROM equipments
   WHERE controla_estacionamento = 1 AND tipo = 'controle_acesso'`).forEach(e => console.log(`  id=${e.id} ${e.name}`));

console.log('\n=== FK vehicles → persons_old? ===');
const fk = q("PRAGMA foreign_key_list('vehicles')");
console.log(fk);

console.log('\n=== ESTACIONAMENTOS ===');
q('SELECT id, name, type, total_spots, active, substr(empresas,1,200) as empresas FROM parkings').forEach(p => console.log(p));

console.log('\n=== REGRAS veiculares sem equipamento de saída no JSON ===');
const vehicleRules = q(`SELECT id, name, equipments FROM access_rules WHERE active = 1 AND access_target = 'vehicles'`);
const exitEquipIds = new Set(q(`SELECT id FROM equipments WHERE controla_estacionamento = 1 AND equipamento_saida = 1`).map(r => r.id));
for (const rule of vehicleRules) {
  let eq = [];
  try { eq = JSON.parse(rule.equipments || '[]'); } catch (e) {}
  const hasExit = eq.some(id => exitEquipIds.has(Number(id)));
  if (!hasExit) console.log(`  rule ${rule.id} "${rule.name}" — sem equip. saída nos IDs: ${rule.equipments}`);
}

db.close();

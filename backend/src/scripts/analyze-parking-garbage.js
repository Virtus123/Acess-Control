/**
 * Análise de inconsistências de estacionamento em um tenant SQLite.
 * Uso: node src/scripts/analyze-parking-garbage.js [tenantId]
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tenantId = process.argv[2] || 'haofices';
const dbPath = join(__dirname, '..', '..', 'database', 'tenants', `tenant_${tenantId}.db`);

const db = new Database(dbPath, { readonly: true });

function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function q(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function q1(sql, params = []) {
  return db.prepare(sql).get(...params);
}

console.log(`Analisando: ${dbPath}`);

section('1. VEÍCULOS — status active (fantasmas no pátio)');
const vehiclesActive = q1("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active'");
const vehiclesActiveNoParking = q1("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active' AND (parking_id IS NULL OR parking_id = '')");
const vehiclesInactiveWithParking = q1("SELECT COUNT(*) as n FROM vehicles WHERE status = 'inactive' AND parking_id IS NOT NULL");
console.log(`Total vehicles.status = 'active': ${vehiclesActive.n}`);
console.log(`  active SEM parking_id (suspeito rotativo/import): ${vehiclesActiveNoParking.n}`);
console.log(`  inactive COM parking_id (inconsistente): ${vehiclesInactiveWithParking.n}`);

const activeSamples = q(`
  SELECT v.id, v.plate, v.license_plate, v.status, v.parking_id, v.company_id,
         p.name as person_name, pk.name as parking_name
  FROM vehicles v
  LEFT JOIN persons p ON p.id = v.person_id
  LEFT JOIN parkings pk ON pk.id = v.parking_id
  WHERE v.status = 'active'
  ORDER BY v.id
  LIMIT 15
`);
console.log('\nAmostra (até 15) veículos active:');
activeSamples.forEach(v => {
  console.log(`  id=${v.id} placa=${v.plate || v.license_plate} parking_id=${v.parking_id} company=${v.company_id} pessoa=${v.person_name}`);
});

section('2. VEÍCULOS active vs access_log (última passagem)');
const activeNoEntryLog = q1(`
  SELECT COUNT(*) as n FROM vehicles v
  WHERE v.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM access_log al
      WHERE al.vehicle_id = v.id
        AND al.action = 'ENTRY' AND al.status = 'SUCCESS'
        AND (al.access_type = 'VEHICLE' OR al.access_type IS NULL)
    )
`);
console.log(`Veículos active SEM nenhum log ENTRY SUCCESS: ${activeNoEntryLog.n}`);

const activeLastExit = q(`
  SELECT v.id, v.plate, v.license_plate,
    (SELECT MAX(al.created_at) FROM access_log al WHERE al.vehicle_id = v.id AND al.action = 'ENTRY' AND al.status = 'SUCCESS') as last_entry,
    (SELECT MAX(al.created_at) FROM access_log al WHERE al.vehicle_id = v.id AND al.action = 'EXIT' AND al.status = 'SUCCESS') as last_exit
  FROM vehicles v
  WHERE v.status = 'active'
  LIMIT 20
`);
let ghostByLog = 0;
activeLastExit.forEach(v => {
  if (v.last_exit && v.last_entry && v.last_exit > v.last_entry) ghostByLog++;
});
console.log(`Na amostra de 20 active: ${ghostByLog} com última EXIT > última ENTRY (fantasma por log)`);

section('3. PESSOAS — on_premisse vs veículos');
const personsOnPremise = q1("SELECT COUNT(*) as n FROM persons WHERE on_premisse = 1");
const personsOnPremiseNoActiveVehicle = q1(`
  SELECT COUNT(*) as n FROM persons p
  WHERE p.on_premisse = 1
    AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = p.id AND v.status = 'active')
`);
console.log(`persons.on_premisse = 1: ${personsOnPremise.n}`);
console.log(`  on_premisse=1 mas SEM veículo active: ${personsOnPremiseNoActiveVehicle.n}`);

section('4. EQUIPAMENTOS — controla_estacionamento indevido (pré-migration 090)');
const badEquip = q(`
  SELECT id, name, tipo, modelo, controla_estacionamento, equipamento_saida
  FROM equipments
  WHERE controla_estacionamento = 1
    AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
    AND (modelo IS NULL OR modelo <> 'IDUHF')
`);
console.log(`Equipamentos com flag indevido (catraca etc.): ${badEquip.length}`);
badEquip.slice(0, 10).forEach(e => {
  console.log(`  id=${e.id} ${e.name} tipo=${e.tipo} modelo=${e.modelo}`);
});

section('5. EQUIPAMENTOS de pátio (facial/UHF) com flag');
const parkingEquip = q(`
  SELECT id, name, tipo, modelo, controla_estacionamento, equipamento_saida
  FROM equipments
  WHERE tipo IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
     OR modelo = 'IDUHF'
  ORDER BY controla_estacionamento DESC, name
`);
console.log(`Total equipamentos de pátio: ${parkingEquip.length}`);
parkingEquip.forEach(e => {
  console.log(`  ${e.controla_estacionamento ? 'ON ' : 'off'} | ${e.name} | tipo=${e.tipo} | saida=${e.equipamento_saida}`);
});

section('6. ESTACIONAMENTOS e cotas por empresa');
const parkings = q("SELECT id, name, type, total_spots, empresas, active FROM parkings");
parkings.forEach(p => {
  let empCount = 0;
  try {
    const emp = JSON.parse(p.empresas || '[]');
    empCount = emp.length;
  } catch (e) {}
  console.log(`  id=${p.id} ${p.name} type=${p.type} spots=${p.total_spots} empresas_json=${empCount} active=${p.active}`);
});

section('7. OCUPAÇÃO por estacionamento/empresa (contagem atual active)');
const occupancy = q(`
  SELECT v.parking_id, pk.name, v.company_id, c.corporate_name, c.trading_name,
         COUNT(*) as ocupados
  FROM vehicles v
  LEFT JOIN parkings pk ON pk.id = v.parking_id
  LEFT JOIN companies c ON c.id = v.company_id
  WHERE v.status = 'active' AND v.parking_id IS NOT NULL
  GROUP BY v.parking_id, v.company_id
  ORDER BY ocupados DESC
  LIMIT 20
`);
console.log('Top ocupações (active com parking_id):');
occupancy.forEach(o => {
  console.log(`  parking=${o.name || o.parking_id} empresa=${o.trading_name || o.corporate_name || o.company_id} ocupados=${o.ocupados}`);
});

section('8. REGRAS veiculares com max_vehicles');
const rules = q(`
  SELECT id, name, access_type, max_vehicles, parking_type, parkings, active
  FROM access_rules
  WHERE active = 1 AND (access_target = 'vehicles' OR access_target IS NULL OR access_target = '')
`);
rules.forEach(r => {
  console.log(`  id=${r.id} ${r.name} max_vehicles=${r.max_vehicles} parking_type=${r.parking_type} parkings=${r.parkings}`);
});

section('9. IMPORT IDSecure — veículos criados como active no cadastro');
const importActive = q1(`
  SELECT COUNT(*) as n FROM vehicles
  WHERE status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM access_log al WHERE al.vehicle_id = vehicles.id
    )
`);
console.log(`Veículos active sem NENHUM access_log (provável import/cadastro): ${importActive.n}`);

section('10. RESUMO — itens a limpar');
const summary = {
  vehicles_active_total: vehiclesActive.n,
  vehicles_active_no_parking_id: vehiclesActiveNoParking.n,
  vehicles_inactive_with_parking_id: vehiclesInactiveWithParking.n,
  vehicles_active_no_entry_log: activeNoEntryLog.n,
  vehicles_active_no_any_log: importActive.n,
  persons_on_premise_orphan: personsOnPremiseNoActiveVehicle.n,
  equipments_wrong_parking_flag: badEquip.length,
};
console.log(JSON.stringify(summary, null, 2));

db.close();

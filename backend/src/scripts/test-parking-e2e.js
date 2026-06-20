/**
 * Teste E2E — estacionamento, controle de vagas, guarda por tipo de equipamento.
 *
 * Uso:
 *   node src/scripts/test-parking-e2e.js
 *   node src/scripts/test-parking-e2e.js --keep-tenant
 *   node src/scripts/test-parking-e2e.js --skip-server   # backend já rodando na 3099
 *
 * Sobe backend na porta 3099 com tenant isolado test_parking_e2e.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dbManager from '../config/database.js';
import { runMigrations } from '../database/migrate.js';
import { invalidateCache } from '../services/autorizadorService.js';
import { participatesInParkingControl, isParkingEquipment } from '../utils/equipmentType.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(__dirname, '..', '..');
const TENANTS_PATH = join(BACKEND_ROOT, 'database', 'tenants');
const TENANT_ID = 'test_parking_e2e';
const API_PORT = process.env.E2E_PORT || '3099';
const BASE = `http://127.0.0.1:${API_PORT}/api`;

const args = process.argv.slice(2);
const keepTenant = args.includes('--keep-tenant');
const skipServer = args.includes('--skip-server');

const results = [];

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function apiAccess(tenantId, equipValidator, userId, extra = {}) {
  const res = await fetch(`${BASE}/autorizacao/access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      equip_validator: equipValidator,
      user_id: String(userId),
      ...extra,
    }),
  });
  const json = await res.json();
  return { httpStatus: res.status, allowed: json.status === true, ...json };
}

async function waitForServer(maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/autorizacao/status`);
      if (r.ok) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  return spawn('node', ['server.js'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: API_PORT,
      NODE_ENV: 'development',
      SERVE_FRONTEND: 'false',
      DATABASE_STORAGE: TENANTS_PATH,
      SECURITY_DB_PATH: join(BACKEND_ROOT, 'database', 'security.db'),
      GLOBAL_DB_PATH: join(BACKEND_ROOT, 'database', 'global_notifications.db'),
      JWT_SECRET: 'e2e_test_secret',
      JWT_REFRESH_SECRET: 'e2e_test_refresh',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function setupTenant() {
  const dbPath = join(TENANTS_PATH, `tenant_${TENANT_ID}.db`);
  try {
    await fs.unlink(dbPath);
    await fs.unlink(dbPath + '-wal').catch(() => {});
    await fs.unlink(dbPath + '-shm').catch(() => {});
  } catch (e) {}

  await dbManager.init();
  await runMigrations(TENANT_ID);
  await dbManager.closeConnection(TENANT_ID);
  const db = await dbManager.getConnection(TENANT_ID);
  // Migrações podem deixar foreign_keys=ON; FKs legadas apontam para persons_old (migration 056).
  await db.exec('PRAGMA foreign_keys=OFF');

  await db.run(
    `INSERT INTO companies (id, corporate_name, trading_name, cnpj, active) VALUES (9001, 'Empresa Teste E2E', 'E2E Corp', '00000000000191', 1)`
  );

  const empresasJson = JSON.stringify([{ empresaId: 9001, vagas: 2 }]);
  await db.run(
    `INSERT INTO parkings (id, name, type, total_spots, active, empresas) VALUES (1, 'Pátio Teste', 'rotativo', 10, 1, ?)`,
    [empresasJson]
  );

  const persons = [
    { reg: '10001', name: 'Condutor Um' },
    { reg: '10002', name: 'Condutor Dois' },
    { reg: '10003', name: 'Condutor Três' },
  ];

  for (const p of persons) {
    const cpf = p.reg === '10001' ? '11111111111' : p.reg === '10002' ? '22222222222' : '33333333333';
    await db.run(
      `INSERT INTO persons (registration_number, name, cpf, company_id, status) VALUES (?, ?, ?, 9001, 'active')`,
      [p.reg, p.name, cpf]
    );
  }

  const pids = await db.all('SELECT id, registration_number FROM persons ORDER BY id');
  const plates = ['E2E0001', 'E2E0002', 'E2E0003'];
  for (let i = 0; i < pids.length; i++) {
    await db.run(
      `INSERT INTO vehicles (person_id, license_plate, plate, company_id, status) VALUES (?, ?, ?, 9001, 'inactive')`,
      [pids[i].id, plates[i], plates[i]]
    );
  }

  const catraca = await db.run(
    `INSERT INTO equipments (tenant_id, equip_id, name, tipo, modelo, validador, controla_estacionamento, equipamento_saida, status, active)
     VALUES (?, 'CAT_E2E', 'Catraca Teste', 'controle_acesso', 'iDBlock', 'CAT_E2E', 0, 0, 'active', 1)`,
    [TENANT_ID]
  );
  const faceIn = await db.run(
    `INSERT INTO equipments (tenant_id, equip_id, name, tipo, modelo, validador, controla_estacionamento, equipamento_saida, status, active)
     VALUES (?, 'FACE_IN_E2E', 'Facial Entrada Teste', 'facial_entrada', 'IDFace', 'FACE_IN_E2E', 1, 0, 'active', 1)`,
    [TENANT_ID]
  );
  const faceOut = await db.run(
    `INSERT INTO equipments (tenant_id, equip_id, name, tipo, modelo, validador, controla_estacionamento, equipamento_saida, status, active)
     VALUES (?, 'FACE_OUT_E2E', 'Facial Saída Teste', 'facial_saida', 'IDFace', 'FACE_OUT_E2E', 1, 1, 'active', 1)`,
    [TENANT_ID]
  );
  const uhf = await db.run(
    `INSERT INTO equipments (tenant_id, equip_id, name, tipo, modelo, validador, controla_estacionamento, equipamento_saida, status, active)
     VALUES (?, 'UHF_E2E', 'UHF Teste', 'uhf', 'IDUHF', 'UHF_E2E', 1, 0, 'active', 1)`,
    [TENANT_ID]
  );

  await db.run(
    `INSERT INTO access_rules (tenant_id, name, access_type, equipments, schedule_type, active, access_target)
     VALUES (?, 'Regra Pessoa Catraca', 'todos', ?, 'livre', 1, 'persons')`,
    [TENANT_ID, JSON.stringify([catraca.lastID])]
  );

  await db.run(
    `INSERT INTO access_rules (tenant_id, name, access_type, equipments, schedule_type, active, access_target, parkings, parking_type, max_vehicles)
     VALUES (?, 'Regra Veículo Pátio', 'todos', ?, 'livre', 1, 'vehicles', ?, 'rotativo', 2)`,
    [TENANT_ID, JSON.stringify([faceIn.lastID, faceOut.lastID, uhf.lastID]), JSON.stringify([1])]
  );

  await db.run(
    `UPDATE vehicles SET uhf_tag = '021,99999' WHERE plate = 'E2E0001'`
  );

  invalidateCache(TENANT_ID);

  await dbManager.closeConnection(TENANT_ID);

  return {
    ids: { catraca: catraca.lastID, faceIn: faceIn.lastID, faceOut: faceOut.lastID, uhf: uhf.lastID },
    persons: pids,
  };
}

async function getDb() {
  return dbManager.getConnection(TENANT_ID);
}

async function vehicleStatus(db, plate) {
  return db.get('SELECT status, parking_id FROM vehicles WHERE plate = ?', [plate]);
}

async function countActive(db) {
  return (await db.get("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active'"))?.n ?? 0;
}

async function runTests(db) {
  console.log('\n--- Testes unitários (helpers) ---');
  record(
    'Catraca não participa de estacionamento',
    participatesInParkingControl({ tipo: 'controle_acesso', controla_estacionamento: 1 }) === false
  );
  record(
    'Facial com flag participa',
    participatesInParkingControl({ tipo: 'facial_entrada', controla_estacionamento: 1 }) === true
  );
  record(
    'UHF IDUHF participa',
    participatesInParkingControl({ tipo: 'uhf', modelo: 'IDUHF', controla_estacionamento: 1 }) === true
  );

  console.log('\n--- Testes via API ---');

  // T1: Catraca — não altera veículo
  let r = await apiAccess(TENANT_ID, 'CAT_E2E', '10001');
  const vAfterCatraca = await vehicleStatus(db, 'E2E0001');
  record(
    'T1 Catraca: acesso pessoa',
    r.allowed === true,
    `allowed=${r.allowed}, msg=${r.message}`
  );
  record(
    'T1 Catraca: veículo permanece inactive',
    vAfterCatraca?.status === 'inactive',
    `status=${vAfterCatraca?.status}`
  );

  // T2: Entrada facial 1
  r = await apiAccess(TENANT_ID, 'FACE_IN_E2E', '10001');
  const v1in = await vehicleStatus(db, 'E2E0001');
  record('T2 Facial entrada P1 liberada', r.allowed === true, r.message);
  record('T2 Veículo E2E0001 active + parking_id', v1in?.status === 'active' && v1in?.parking_id === 1, JSON.stringify(v1in));

  // T3: Entrada facial 2 (última vaga)
  r = await apiAccess(TENANT_ID, 'FACE_IN_E2E', '10002');
  const active2 = await countActive(db);
  record('T3 Facial entrada P2 liberada', r.allowed === true, r.message);
  record('T3 Ocupação = 2', active2 === 2, `active=${active2}`);

  // T4: Terceira entrada — cota estourada
  r = await apiAccess(TENANT_ID, 'FACE_IN_E2E', '10003');
  const v3 = await vehicleStatus(db, 'E2E0003');
  record('T4 Terceira entrada NEGADA (cota 2)', r.allowed === false, r.message);
  record('T4 Veículo P3 continua inactive', v3?.status === 'inactive', `status=${v3?.status}`);

  // T5: Dupla entrada
  r = await apiAccess(TENANT_ID, 'FACE_IN_E2E', '10001');
  record('T5 Dupla entrada P1 NEGADA', r.allowed === false, r.message);

  // T6: Saída facial
  r = await apiAccess(TENANT_ID, 'FACE_OUT_E2E', '10001');
  const v1out = await vehicleStatus(db, 'E2E0001');
  record('T6 Saída P1 registrada', r.allowed === true, r.message);
  record('T6 Veículo E2E0001 inactive', v1out?.status === 'inactive', JSON.stringify(v1out));

  // T7: Após saída, P3 consegue entrar
  r = await apiAccess(TENANT_ID, 'FACE_IN_E2E', '10003');
  const v3in = await vehicleStatus(db, 'E2E0003');
  record('T7 Após liberação vaga, P3 entra', r.allowed === true, r.message);
  record('T7 E2E0003 active', v3in?.status === 'active', JSON.stringify(v3in));

  // T8: UHF — sair P2/P3 para liberar vagas, depois leitura tag do veículo P1
  await apiAccess(TENANT_ID, 'FACE_OUT_E2E', '10002');
  await apiAccess(TENANT_ID, 'FACE_OUT_E2E', '10003');
  await db.run("UPDATE vehicles SET status = 'inactive', parking_id = NULL");

  const uhfRes = await fetch(`${BASE}/comunicador/uhf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: TENANT_ID,
      equip_validator: 'UHF_E2E',
      uhf_tag: '021,99999',
      device_id: 'test-device',
      uuid: `e2e-${Date.now()}`,
    }),
  });
  const uhfJson = await uhfRes.json();
  const v1uhf = await vehicleStatus(db, 'E2E0001');
  record('T8 UHF leitura tag E2E0001', uhfRes.ok && uhfJson.status === true, JSON.stringify(uhfJson).slice(0, 150));
  record('T8 UHF marca veículo active', v1uhf?.status === 'active', JSON.stringify(v1uhf));

  // T9: Equipamento API — catraca não pode manter flag (direct DB simulating controller logic)
  const fakeCatraca = { tipo: 'controle_acesso', modelo: 'iDBlock', controla_estacionamento: 1 };
  record(
    'T9 Guarda bloqueia catraca mesmo com flag=1',
    !participatesInParkingControl(fakeCatraca),
    'participatesInParkingControl=false'
  );

  // T10: isParkingEquipment
  record('T10 Catraca não é parking equipment', !isParkingEquipment({ tipo: 'controle_acesso' }));
  record('T10 Facial é parking equipment', isParkingEquipment({ tipo: 'facial_entrada' }));
}

async function cleanupTenant() {
  if (keepTenant) {
    console.log(`\nTenant ${TENANT_ID} mantido em ${TENANTS_PATH}`);
    return;
  }
  await dbManager.closeConnection(TENANT_ID);
  const dbPath = join(TENANTS_PATH, `tenant_${TENANT_ID}.db`);
  await fs.unlink(dbPath).catch(() => {});
}

async function main() {
  console.log('='.repeat(70));
  console.log('TESTE E2E — Controle de Estacionamento');
  console.log('='.repeat(70));

  await fs.mkdir(TENANTS_PATH, { recursive: true });
  await setupTenant();
  console.log(`Tenant ${TENANT_ID} criado e populado.`);

  let serverProc = null;
  if (!skipServer) {
    serverProc = startServer();
    const ok = await waitForServer();
    if (!ok) {
      console.error('Backend não subiu a tempo na porta', API_PORT);
      serverProc.kill();
      process.exit(1);
    }
    console.log(`Backend OK em ${BASE}`);
  } else {
    console.log('Usando backend existente (--skip-server)');
  }

  const db = await getDb();

  try {
    await runTests(db);
  } finally {
    if (serverProc) serverProc.kill();
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);

  console.log('\n' + '='.repeat(70));
  console.log('RELATÓRIO FINAL');
  console.log('='.repeat(70));
  console.log(`Total: ${results.length} | Passou: ${passed} | Falhou: ${failed.length}`);

  if (failed.length) {
    console.log('\nFalhas:');
    failed.forEach(f => console.log(`  ❌ ${f.name}: ${f.detail}`));
  } else {
    console.log('\n✅ Todos os testes passaram.');
  }

  await cleanupTenant();
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

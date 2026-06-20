/**
 * Limpeza de inconsistências de estacionamento (dados do fluxo antigo).
 *
 * ⚠️  Para produção (haofices), prefira:
 *     node src/scripts/fix-parking-production.js --analyze|--dry-run|--apply haofices
 *
 * Uso deste script (legado / limpeza simples):
 *   node src/scripts/cleanup-parking-garbage.js --analyze haofices
 *   node src/scripts/cleanup-parking-garbage.js --dry-run haofices
 *   node src/scripts/cleanup-parking-garbage.js haofices
 *   node src/scripts/cleanup-parking-garbage.js haofices --skip-backup
 *   node src/scripts/cleanup-parking-garbage.js haofices --keep-person-presence
 */

import 'dotenv/config';
import dbManager from '../config/database.js';
import backupService from '../services/backupService.js';

const args = process.argv.slice(2);
const isAnalyze = args.includes('--analyze');
const isDryRun = args.includes('--dry-run');
const skipBackup = args.includes('--skip-backup');
const keepPersonPresence = args.includes('--keep-person-presence');
const tenantId = args.find(a => !a.startsWith('--'));

if (!tenantId) {
  console.error('Uso: node src/scripts/cleanup-parking-garbage.js [--analyze|--dry-run] <tenantId>');
  process.exit(1);
}

function section(title) {
  console.log('\n' + '='.repeat(68));
  console.log(title);
  console.log('='.repeat(68));
}

async function analyze(db) {
  section(`DIAGNÓSTICO — tenant ${tenantId}`);

  const active = (await db.get("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active'"))?.n ?? 0;
  const noLog = (await db.get(`
    SELECT COUNT(*) as n FROM vehicles v
    WHERE v.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM access_log al WHERE al.vehicle_id = v.id)
  `))?.n ?? 0;
  const multiPerson = (await db.get(`
    SELECT COUNT(*) as n FROM (
      SELECT person_id FROM vehicles WHERE status = 'active' GROUP BY person_id HAVING COUNT(*) > 1
    )
  `))?.n ?? 0;
  const badEquip = (await db.get(`
    SELECT COUNT(*) as n FROM equipments
    WHERE controla_estacionamento = 1
      AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
      AND (modelo IS NULL OR modelo <> 'IDUHF')
  `))?.n ?? 0;
  const idfaceWrongTipo = (await db.get(`
    SELECT COUNT(*) as n FROM equipments
    WHERE controla_estacionamento = 1
      AND tipo = 'controle_acesso'
      AND (modelo LIKE '%Face%' OR modelo LIKE '%FACE%' OR name LIKE '%ESTAC%')
  `))?.n ?? 0;
  const onPremiseOrphan = (await db.get(`
    SELECT COUNT(*) as n FROM persons p
    WHERE p.on_premisse = 1
      AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = p.id AND v.status = 'active')
  `))?.n ?? 0;
  const rulesNoMax = (await db.get(`
    SELECT COUNT(*) as n FROM access_rules
    WHERE active = 1
      AND (access_target = 'vehicles' OR access_target IS NULL OR access_target = '')
      AND (max_vehicles IS NULL OR max_vehicles = 0)
  `))?.n ?? 0;

  console.log(`Veículos status=active (ocupação fantasma):     ${active}`);
  console.log(`  └ sem nenhum access_log (import/cadastro):    ${noLog}`);
  console.log(`Pessoas com 2+ veículos active (bug antigo):    ${multiPerson}`);
  console.log(`Equip. flag estacionamento em tipo errado:      ${badEquip}`);
  console.log(`  └ IDFace estacionamento tipo controle_acesso: ${idfaceWrongTipo}`);
  console.log(`Pessoas on_premisse sem veículo active:         ${onPremiseOrphan}`);
  console.log(`Regras veiculares SEM max_vehicles (sem cota):  ${rulesNoMax}`);

  const parking = await db.get('SELECT total_spots, empresas FROM parkings WHERE id = 1');
  if (parking?.empresas) {
    let empresas = [];
    try { empresas = JSON.parse(parking.empresas); } catch (e) {}
    let over = 0;
    for (const e of empresas) {
      const row = await db.get(
        'SELECT COUNT(*) as c FROM vehicles WHERE status = ? AND parking_id = 1 AND company_id = ?',
        ['active', e.empresaId]
      );
      if ((row?.c ?? 0) > e.vagas) over++;
    }
    console.log(`Empresas com cota estourada (dados sujos):     ${over} de ${empresas.length}`);
    console.log(`Capacidade total_spots: ${parking.total_spots}, active no pátio: ${active}`);
  }

  if (rulesNoMax > 0) {
    console.log('\n⚠️  ATENÇÃO: regras veiculares existem mas max_vehicles está vazio.');
    console.log('   O controle de vagas por empresa NÃO dispara até configurar max_vehicles > 0 nas regras.');
  }

  return { active, noLog, multiPerson, badEquip, idfaceWrongTipo, onPremiseOrphan };
}

async function cleanup(db) {
  const stats = {
    equip_idface_tipo_fixed: 0,
    equip_flag_cleared: 0,
    vehicles_reset: 0,
    persons_presence_reset: 0,
  };

  const idfaceRows = await db.all(`
    SELECT id, name, equipamento_saida FROM equipments
    WHERE controla_estacionamento = 1
      AND tipo = 'controle_acesso'
      AND (
        modelo LIKE '%Face%' OR modelo LIKE '%FACE%'
        OR UPPER(name) LIKE '%ESTAC%'
      )
  `);

  for (const row of idfaceRows) {
    const novoTipo = row.equipamento_saida === 1 ? 'facial_saida' : 'facial_entrada';
    if (!isDryRun) {
      await db.run(
        `UPDATE equipments SET tipo = ?, controla_estacionamento = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [novoTipo, row.id]
      );
    }
    stats.equip_idface_tipo_fixed++;
    console.log(`  [equip] id=${row.id} "${row.name}" → tipo=${novoTipo}`);
  }

  const badBefore = (await db.get(`
    SELECT COUNT(*) as n FROM equipments
    WHERE controla_estacionamento = 1
      AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
      AND (modelo IS NULL OR modelo <> 'IDUHF')
  `))?.n ?? 0;

  if (badBefore > 0) {
    if (!isDryRun) {
      await db.run(`
        UPDATE equipments
        SET controla_estacionamento = 0, updated_at = CURRENT_TIMESTAMP
        WHERE controla_estacionamento = 1
          AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
          AND (modelo IS NULL OR modelo <> 'IDUHF')
      `);
    }
    stats.equip_flag_cleared = badBefore;
    console.log(`  [equip] controla_estacionamento desligado em ${badBefore} equipamento(s) indevido(s)`);
  }

  const toReset = (await db.get(`
    SELECT COUNT(*) as n FROM vehicles WHERE status = 'active' OR parking_id IS NOT NULL
  `))?.n ?? 0;

  if (toReset > 0) {
    if (!isDryRun) {
      await db.run(`
        UPDATE vehicles SET status = 'inactive', parking_id = NULL
        WHERE status = 'active' OR parking_id IS NOT NULL
      `);
    }
    stats.vehicles_reset = toReset;
    console.log(`  [vehicles] resetados ${toReset} registro(s) (active / parking_id)`);
  }

  if (!keepPersonPresence) {
    const persons = (await db.get(`
      SELECT COUNT(*) as n FROM persons WHERE on_premisse = 1 OR exited = 1
    `))?.n ?? 0;

    if (persons > 0) {
      if (!isDryRun) {
        await db.run(`
          UPDATE persons SET on_premisse = 0, exited = 0
          WHERE on_premisse = 1 OR exited = 1
        `);
      }
      stats.persons_presence_reset = persons;
      console.log(`  [persons] on_premisse/exited zerados em ${persons} pessoa(s)`);
      console.log('           (use --keep-person-presence se catracas mantêm presença real)');
    }
  } else {
    console.log('  [persons] presença mantida (--keep-person-presence)');
  }

  return stats;
}

async function run() {
  if (!(await dbManager.tenantExists(tenantId))) {
    console.error(`Tenant não encontrado: ${tenantId}`);
    process.exit(1);
  }

  const db = await dbManager.getConnection(tenantId);
  const before = await analyze(db);

  if (isAnalyze) {
    console.log('\nModo --analyze: nenhuma alteração feita.');
    process.exit(0);
  }

  section(isDryRun ? 'SIMULAÇÃO DE LIMPEZA (--dry-run)' : 'APLICANDO LIMPEZA');

  if (!isDryRun && !skipBackup) {
    console.log('Criando backup...');
    try {
      const backup = await backupService.createBackup(tenantId, 'manual');
      console.log(`Backup OK: ${backup.filename} (${(backup.size_bytes / 1024 / 1024).toFixed(2)} MB)`);
    } catch (e) {
      console.error('Falha no backup:', e.message);
      console.error('Abortando. Use --skip-backup apenas se souber o risco.');
      process.exit(1);
    }
  }

  const stats = await cleanup(db);

  section('DEPOIS');
  const after = await analyze(db);

  section('RESUMO');
  console.log(JSON.stringify({ tenantId, dryRun: isDryRun, before, stats, after }, null, 2));

  if (isDryRun) {
    console.log('\n*** DRY-RUN — nenhuma alteração persistida ***');
  } else {
    console.log('\nLimpeza concluída. Reinicie o backend e valide no painel.');
    console.log('Configure max_vehicles > 0 nas regras veiculares para ativar cota por empresa.');
  }

  setTimeout(() => process.exit(0), 300);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

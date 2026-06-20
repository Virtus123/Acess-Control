/**
 * Correção segura de estacionamento — PRODUÇÃO
 *
 * Limpa ocupação fantasma, corrige equipamentos/regras e ativa controle de vagas
 * sem alterar grupos, horários ou público das regras existentes.
 *
 * Uso:
 *   node src/scripts/fix-parking-production.js --analyze haofices
 *   node src/scripts/fix-parking-production.js --dry-run haofices
 *   node src/scripts/fix-parking-production.js --apply --skip-backup haofices
 *
 * Flags:
 *   --analyze              Só diagnóstico (padrão se não passar --dry-run nem --apply)
 *   --dry-run              Simula todas as etapas
 *   --apply                Grava alterações (obrigatório em produção)
 *   --skip-backup          Não recomendado
 *   --keep-person-presence Não mexe em on_premisse/exited (padrão recomendado em produção)
 *   --reset-all-presence   Zera on_premisse/exited em TODAS as pessoas (agressivo)
 *   --reset-all-occupancy  Reseta TODOS os veículos active (padrão: só fantasmas sem log)
 *   --skip-rules           Não altera access_rules
 *   --skip-equipment       Não altera equipments
 *
 * Sempre faz backup SQLite (.db) antes de --apply, salvo --skip-backup.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import { join } from 'path';
import Database from 'better-sqlite3';
import dbManager from '../config/database.js';
import { invalidateCache } from '../services/autorizadorService.js';
import { invalidate as invalidateRuleResolver } from '../services/accessRuleResolver.js';

const args = process.argv.slice(2);
const isAnalyze = args.includes('--analyze') || (!args.includes('--dry-run') && !args.includes('--apply'));
const isDryRun = args.includes('--dry-run');
const isApply = args.includes('--apply');
const skipBackup = args.includes('--skip-backup');
const keepPersonPresence = args.includes('--keep-person-presence');
const resetAllPresence = args.includes('--reset-all-presence');
const resetAllOccupancy = args.includes('--reset-all-occupancy');
const skipRules = args.includes('--skip-rules');
const skipEquipment = args.includes('--skip-equipment');
const tenantId = args.find(a => !a.startsWith('--'));

/** Perfil por tenant — só o que sabemos ser seguro; grupos/horários NÃO são alterados. */
const TENANT_PROFILES = {
  haofices: {
    parkingId: 1,
    parkingEquipmentIds: [29, 30],
    personRuleIds: [2, 3],
    vehicleRuleIds: [5, 6],
    /** max_vehicles > 0 liga a cota; limites reais vêm do JSON empresas do estacionamento. */
    maxVehiclesFlag: 1,
    parkingType: 'rotativo',
  },
};

if (!tenantId) {
  console.error('Uso: node src/scripts/fix-parking-production.js [--analyze|--dry-run|--apply] <tenantId>');
  process.exit(1);
}

if (isApply && isDryRun) {
  console.error('Use apenas um de: --analyze, --dry-run, --apply');
  process.exit(1);
}

const profile = TENANT_PROFILES[tenantId] || null;
const writeMode = isApply && !isDryRun;

function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function normalizeEquipIds(raw) {
  return parseJsonArray(raw)
    .map(x => Number(x))
    .filter(n => !Number.isNaN(n));
}

async function analyze(db) {
  section(`DIAGNÓSTICO — ${tenantId}`);

  const active = (await db.get("SELECT COUNT(*) as n FROM vehicles WHERE status = 'active'"))?.n ?? 0;
  const ghosts = (await db.get(`
    SELECT COUNT(*) as n FROM vehicles v
    WHERE v.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM access_log al
        WHERE al.vehicle_id = v.id
          AND al.action = 'ENTRY'
          AND al.status = 'SUCCESS'
          AND (al.access_type = 'VEHICLE' OR al.access_type IS NULL)
      )
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
  const idfaceWrong = (await db.get(`
    SELECT COUNT(*) as n FROM equipments
    WHERE controla_estacionamento = 1 AND tipo = 'controle_acesso'
      AND (modelo LIKE '%Face%' OR UPPER(name) LIKE '%ESTAC%')
  `))?.n ?? 0;
  const onPremiseOrphan = (await db.get(`
    SELECT COUNT(*) as n FROM persons p
    WHERE p.on_premisse = 1
      AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = p.id AND v.status = 'active')
  `))?.n ?? 0;
  const rulesNoMax = (await db.get(`
    SELECT COUNT(*) as n FROM access_rules
    WHERE active = 1 AND access_target = 'vehicles'
      AND (max_vehicles IS NULL OR max_vehicles = 0)
  `))?.n ?? 0;

  console.log(`Veículos active (ocupação):                    ${active}`);
  console.log(`  └ fantasmas (active sem log ENTRY):          ${ghosts}`);
  console.log(`Pessoas com 2+ veículos active:                ${multiPerson}`);
  console.log(`Equip. estacionamento em tipo errado:          ${badEquip}`);
  console.log(`  └ IDFace pátio como controle_acesso:         ${idfaceWrong}`);
  console.log(`Pessoas on_premisse sem veículo active:        ${onPremiseOrphan}`);
  console.log(`Regras veiculares sem max_vehicles:            ${rulesNoMax}`);

  const parking = await db.get('SELECT id, name, total_spots, empresas FROM parkings WHERE id = 1');
  if (parking) {
    const empresas = parseJsonArray(parking.empresas);
    let over = 0;
    for (const e of empresas) {
      const row = await db.get(
        'SELECT COUNT(*) as c FROM vehicles WHERE status = ? AND parking_id = 1 AND company_id = ?',
        ['active', e.empresaId]
      );
      if ((row?.c ?? 0) > e.vagas) over++;
    }
    console.log(`Pátio "${parking.name}": ${parking.total_spots} vagas, ${active} active, ${over} empresas estouradas`);
  }

  console.log('\nRegras ativas:');
  const rules = await db.all(
    'SELECT id, name, access_type, access_target, max_vehicles, parking_type, equipments FROM access_rules WHERE active = 1 ORDER BY id'
  );
  for (const r of rules) {
    console.log(`  [${r.id}] ${r.name} | target=${r.access_target} max=${r.max_vehicles} type=${r.parking_type}`);
    console.log(`       equipamentos=${r.equipments}`);
  }

  if (profile) {
    console.log('\nPerfil de correção carregado para este tenant.');
  } else {
    console.log('\n⚠️  Sem perfil TENANT_PROFILES — só limpeza genérica será aplicada.');
  }

  return { active, ghosts, multiPerson, badEquip, idfaceWrong, onPremiseOrphan, rulesNoMax };
}

async function backupDatabase(tenantId) {
  const dbPath = dbManager.getTenantPath(tenantId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = dbPath.replace(/\.db$/, `_backup_${stamp}.db`);

  section('BACKUP');
  console.log(`Origem:  ${dbPath}`);
  console.log(`Destino: ${backupPath}`);
  console.log('(checkpoint WAL + backup SQLite — aguarde em bancos grandes)');

  await dbManager.closeConnection(tenantId);

  const src = new Database(dbPath);
  try {
    src.pragma('wal_checkpoint(TRUNCATE)');
    await src.backup(backupPath);
  } finally {
    src.close();
  }

  const stat = await fs.stat(backupPath);
  console.log(`Backup OK: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  return backupPath;
}

async function existingEquipIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT id FROM equipments WHERE id IN (${placeholders}) AND active = 1`, ids);
  return rows.map(r => r.id);
}

async function fixEquipment(db, stats) {
  section('EQUIPAMENTOS');

  const idfaceRows = await db.all(`
    SELECT id, name, equipamento_saida FROM equipments
    WHERE controla_estacionamento = 1 AND tipo = 'controle_acesso'
      AND (modelo LIKE '%Face%' OR UPPER(name) LIKE '%ESTAC%')
  `);

  for (const row of idfaceRows) {
    const novoTipo = row.equipamento_saida === 1 ? 'facial_saida' : 'facial_entrada';
    console.log(`  IDFace id=${row.id} "${row.name}" → tipo=${novoTipo}`);
    if (writeMode) {
      await db.run(
        `UPDATE equipments SET tipo = ?, controla_estacionamento = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [novoTipo, row.id]
      );
    }
    stats.equip_idface_tipo_fixed++;
  }

  const badCount = (await db.get(`
    SELECT COUNT(*) as n FROM equipments
    WHERE controla_estacionamento = 1
      AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
      AND (modelo IS NULL OR modelo <> 'IDUHF')
  `))?.n ?? 0;

  if (badCount > 0) {
    console.log(`  Desligando controla_estacionamento em ${badCount} equipamento(s) indevido(s)`);
    if (writeMode) {
      await db.run(`
        UPDATE equipments SET controla_estacionamento = 0, updated_at = CURRENT_TIMESTAMP
        WHERE controla_estacionamento = 1
          AND tipo NOT IN ('facial_entrada', 'facial_saida', 'uhf', 'tag')
          AND (modelo IS NULL OR modelo <> 'IDUHF')
      `);
    }
    stats.equip_flag_cleared = badCount;
  }

  // Migration 090 pode ter desligado flag em IDFace ainda com tipo controle_acesso — garantir pátio do perfil
  if (profile?.parkingEquipmentIds?.length) {
    for (const id of profile.parkingEquipmentIds) {
      const row = await db.get(
        'SELECT id, name, tipo, equipamento_saida, controla_estacionamento FROM equipments WHERE id = ?',
        [id]
      );
      if (!row) continue;
      const novoTipo = row.equipamento_saida === 1 ? 'facial_saida' : 'facial_entrada';
      if (row.tipo !== novoTipo || row.controla_estacionamento !== 1) {
        console.log(`  [pátio] id=${row.id} "${row.name}" → tipo=${novoTipo}, flag=1`);
        if (writeMode) {
          await db.run(
            `UPDATE equipments SET tipo = ?, controla_estacionamento = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [novoTipo, id]
          );
        }
        stats.equip_parking_ensured = (stats.equip_parking_ensured || 0) + 1;
      }
    }
  }
}

async function fixOccupancy(db, stats) {
  section('OCUPAÇÃO (veículos)');

  let resetSql;
  let params = [];

  if (resetAllOccupancy) {
    resetSql = `SELECT COUNT(*) as n FROM vehicles WHERE status = 'active' OR parking_id IS NOT NULL`;
    console.log('  Modo --reset-all-occupancy: TODOS active/parking_id serão zerados');
  } else {
    resetSql = `
      SELECT COUNT(*) as n FROM vehicles v
      WHERE v.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM access_log al
          WHERE al.vehicle_id = v.id
            AND al.action = 'ENTRY'
            AND al.status = 'SUCCESS'
            AND (al.access_type = 'VEHICLE' OR al.access_type IS NULL)
        )
    `;
    console.log('  Modo padrão: só fantasmas (active sem log ENTRY SUCCESS)');
  }

  const toReset = (await db.get(resetSql, params))?.n ?? 0;

  if (toReset > 0) {
    if (writeMode) {
      if (resetAllOccupancy) {
        await db.run(`UPDATE vehicles SET status = 'inactive', parking_id = NULL WHERE status = 'active' OR parking_id IS NOT NULL`);
      } else {
        await db.run(`
          UPDATE vehicles SET status = 'inactive', parking_id = NULL
          WHERE status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM access_log al
              WHERE al.vehicle_id = vehicles.id
                AND al.action = 'ENTRY'
                AND al.status = 'SUCCESS'
                AND (al.access_type = 'VEHICLE' OR al.access_type IS NULL)
            )
        `);
      }
    }
    stats.vehicles_reset = toReset;
    console.log(`  Resetados: ${toReset} veículo(s)`);
  } else {
    console.log('  Nenhum veículo a resetar nesta etapa');
  }

  const multi = await db.all(`
    SELECT person_id FROM vehicles WHERE status = 'active' GROUP BY person_id HAVING COUNT(*) > 1
  `);

  for (const { person_id } of multi) {
    const activeVehicles = await db.all(`
      SELECT v.id,
        (SELECT MAX(al.created_at) FROM access_log al
         WHERE al.vehicle_id = v.id AND al.action = 'ENTRY' AND al.status = 'SUCCESS') AS last_entry
      FROM vehicles v
      WHERE v.person_id = ? AND v.status = 'active'
      ORDER BY last_entry DESC, v.id ASC
    `, [person_id]);

    const keepId = activeVehicles[0]?.id;
    const dropIds = activeVehicles.slice(1).map(v => v.id);
    if (dropIds.length) {
      console.log(`  Pessoa ${person_id}: mantém veículo ${keepId}, reseta ${dropIds.join(', ')}`);
      if (writeMode) {
        const ph = dropIds.map(() => '?').join(',');
        await db.run(
          `UPDATE vehicles SET status = 'inactive', parking_id = NULL WHERE id IN (${ph})`,
          dropIds
        );
      }
      stats.vehicles_deduped += dropIds.length;
    }
  }

  if (resetAllPresence) {
    const persons = (await db.get(`SELECT COUNT(*) as n FROM persons WHERE on_premisse = 1 OR exited = 1`))?.n ?? 0;
    if (persons > 0) {
      console.log(`  --reset-all-presence: zerando ${persons} pessoa(s)`);
      if (writeMode) {
        await db.run(`UPDATE persons SET on_premisse = 0, exited = 0 WHERE on_premisse = 1 OR exited = 1`);
      }
      stats.persons_presence_reset = persons;
    }
  } else if (!keepPersonPresence) {
    const orphans = (await db.get(`
      SELECT COUNT(*) as n FROM persons p
      WHERE p.on_premisse = 1
        AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = p.id AND v.status = 'active')
    `))?.n ?? 0;
    if (orphans > 0) {
      console.log(`  Corrigindo ${orphans} pessoa(s) on_premisse=1 sem veículo no pátio`);
      if (writeMode) {
        await db.run(`
          UPDATE persons SET on_premisse = 0
          WHERE on_premisse = 1
            AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.person_id = persons.id AND v.status = 'active')
        `);
      }
      stats.persons_presence_reset = orphans;
    } else {
      console.log('  Presença: nenhuma inconsistência on_premisse sem veículo active');
    }
  } else {
    console.log('  Presença de pessoas mantida (--keep-person-presence)');
  }
}

async function fixRules(db, stats) {
  section('REGRAS DE ACESSO');

  if (!profile) {
    console.log('  Sem perfil — pulando ajuste de regras. Use TENANT_PROFILES ou edite manualmente.');
    return;
  }

  const parkingSet = new Set(profile.parkingEquipmentIds);
  const validParkingIds = await existingEquipIds(db, profile.parkingEquipmentIds);
  if (validParkingIds.length !== profile.parkingEquipmentIds.length) {
    console.warn('  ⚠️  Alguns IDs de equipamento de pátio não existem ou estão inativos:', profile.parkingEquipmentIds);
  }

  for (const ruleId of profile.personRuleIds || []) {
    const rule = await db.get('SELECT id, name, equipments FROM access_rules WHERE id = ? AND active = 1', [ruleId]);
    if (!rule) continue;

    const current = normalizeEquipIds(rule.equipments);
    const cleaned = current.filter(id => !parkingSet.has(id));
    if (cleaned.length === current.length) {
      console.log(`  [${ruleId}] ${rule.name}: person rule OK (sem equip. de pátio)`);
      continue;
    }

    const removed = current.filter(id => parkingSet.has(id));
    console.log(`  [${ruleId}] ${rule.name}: remove equip. pátio ${removed.join(',')} das regras de pessoa`);
    if (writeMode) {
      await db.run(
        `UPDATE access_rules SET equipments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [JSON.stringify(cleaned), ruleId]
      );
    }
    stats.person_rules_trimmed++;
  }

  for (const ruleId of profile.vehicleRuleIds || []) {
    const rule = await db.get(
      'SELECT id, name, equipments, parkings, max_vehicles, parking_type FROM access_rules WHERE id = ? AND active = 1',
      [ruleId]
    );
    if (!rule) continue;

    const current = normalizeEquipIds(rule.equipments);
    const finalEquip = validParkingIds.length ? validParkingIds : profile.parkingEquipmentIds;
    const removed = current.filter(id => !finalEquip.includes(id));

    console.log(`  [${ruleId}] ${rule.name}:`);
    if (removed.length) {
      console.log(`       removidos da regra: [${removed.join(', ')}]`);
    }
    console.log(`       equipamentos → [${finalEquip.join(', ')}]`);
    console.log(`       max_vehicles → ${profile.maxVehiclesFlag}, parking_type → ${profile.parkingType}`);
    console.log(`       (grupos/access_type/horários NÃO alterados)`);

    if (writeMode) {
      await db.run(
        `UPDATE access_rules SET
           equipments = ?,
           parkings = ?,
           max_vehicles = ?,
           parking_type = ?,
           access_target = 'vehicles',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          JSON.stringify(finalEquip),
          JSON.stringify([String(profile.parkingId)]),
          profile.maxVehiclesFlag,
          profile.parkingType,
          ruleId,
        ]
      );
    }
    stats.vehicle_rules_configured++;
  }
}

async function runFixes(db) {
  const stats = {
    equip_idface_tipo_fixed: 0,
    equip_flag_cleared: 0,
    equip_parking_ensured: 0,
    vehicles_reset: 0,
    vehicles_deduped: 0,
    persons_presence_reset: 0,
    person_rules_trimmed: 0,
    vehicle_rules_configured: 0,
  };

  if (!skipEquipment) await fixEquipment(db, stats);
  else console.log('\n[skip] equipamentos');

  await fixOccupancy(db, stats);

  if (!skipRules) await fixRules(db, stats);
  else console.log('\n[skip] regras');

  return stats;
}

async function main() {
  if (!(await dbManager.tenantExists(tenantId))) {
    console.error(`Tenant não encontrado: ${tenantId}`);
    process.exit(1);
  }

  section(`FIX PARKING PRODUCTION — ${tenantId}`);
  console.log(`Modo: ${isApply ? 'APPLY' : isDryRun ? 'DRY-RUN' : 'ANALYZE'}`);

  await dbManager.init();
  await dbManager.getConnection(tenantId).then(db => db.exec('PRAGMA foreign_keys=OFF'));
  const db = await dbManager.getConnection(tenantId);

  const before = await analyze(db);

  if (isAnalyze && !isDryRun && !isApply) {
    console.log('\nNenhuma alteração (--analyze). Próximo passo:');
    console.log(`  node src/scripts/fix-parking-production.js --dry-run ${tenantId}`);
    console.log(`  node src/scripts/fix-parking-production.js --apply ${tenantId}`);
    process.exit(0);
  }

  if (isDryRun) {
    section('SIMULAÇÃO (--dry-run)');
  } else if (isApply) {
    if (!skipBackup) {
      try {
        await backupDatabase(tenantId);
      } catch (e) {
        console.error('Backup falhou:', e.message);
        process.exit(1);
      }
    } else {
      console.warn('\n⚠️  --skip-backup: sem backup!');
    }
    section('APLICANDO CORREÇÕES');
  }

  const db2 = await dbManager.getConnection(tenantId);
  await db2.exec('PRAGMA foreign_keys=OFF');
  const stats = await runFixes(db2);

  section('DEPOIS');
  const after = await analyze(db2);

  section('RESUMO');
  console.log(JSON.stringify({ tenantId, mode: isApply ? 'apply' : 'dry-run', before, stats, after }, null, 2));

  if (writeMode) {
    invalidateCache(tenantId);
    invalidateRuleResolver(tenantId);
    console.log('\n✅ Correções aplicadas. Cache do autorizador invalidado.');
    console.log('   Reinicie o backend e valide: entrada facial → cota → saída.');
    console.log('   Mantenha backup gerado até confirmar operação.');
  } else if (isDryRun) {
    console.log('\n*** DRY-RUN — nada foi gravado ***');
    console.log(`Para aplicar: node src/scripts/fix-parking-production.js --apply ${tenantId}`);
  }

  setTimeout(() => process.exit(0), 400);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

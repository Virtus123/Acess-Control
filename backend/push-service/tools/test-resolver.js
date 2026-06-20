// Testa o accessRuleResolver SEM modificar nada.
// Pra cada equipamento push-enabled do tenant, imprime:
//   - regras ativas que mencionam ele
//   - lista de pessoas autorizadas (com nome+matrícula)
//   - lista de visitantes autorizados
//   - totais
//
// Use pra conferir contra a UI: "esse equip DIRETORIA deveria liberar quem? Bate?"
//
// Uso: node push-service/tools/test-resolver.js [tenant] [equip_id?]
//   tenant defaults to 'pushtest'
//   equip_id opcional — se omitido, varre todos os push-enabled

import { listPushEnabledEquipments, debugEquipment } from '../../src/services/accessRuleResolver.js';
import dbManager from '../../src/config/database.js';

const tenant = process.argv[2] || 'pushtest';
const specificId = process.argv[3] ? parseInt(process.argv[3], 10) : null;

console.log(`\n=== AccessRuleResolver — tenant: ${tenant} ===\n`);

const equips = specificId
  ? [{ id: specificId }]
  : await listPushEnabledEquipments(tenant);

if (equips.length === 0) {
  console.log('Nenhum equipamento push-enabled encontrado.');
  process.exit(0);
}

const db = await dbManager.getConnection(tenant);

for (const e of equips) {
  const info = await debugEquipment(tenant, e.id);
  if (!info.equipment) {
    console.log(`[#${e.id}] equipamento não encontrado`);
    continue;
  }

  console.log(`\n┌─ #${info.equipment.id} ${info.equipment.name} (${info.equipment.validador}) ─────────`);

  if (info.rules.length === 0) {
    console.log('│  ⚠ NENHUMA regra ativa menciona este equipamento');
    console.log('│  → ninguém autorizado, equipamento ficaria vazio');
    continue;
  }

  console.log(`│  ${info.rules.length} regra(s) ativa(s):`);
  for (const r of info.rules) {
    const detail = [];
    if (r.access_type === 'pessoas-especificas') detail.push(`persons=[${r.persons.join(',')}]`);
    if (r.access_type === 'grupos') detail.push(`groups=[${r.groups.join(',')}]`);
    if (r.access_type === 'empresas') detail.push(`companies=[${r.companies.join(',')}]`);
    console.log(`│    • [${r.access_type}] ${r.name} ${detail.join(' ')}`);
  }

  console.log(`│  Totais: ${info.totals.persons} pessoa(s), ${info.totals.visitors} visitante(s)`);

  // Resolve nomes pra log mais útil
  if (info.authorizedPersons.length > 0) {
    const ph = info.authorizedPersons.map(() => '?').join(',');
    const persons = await db.all(
      `SELECT id, name, registration_number FROM persons WHERE id IN (${ph}) ORDER BY id`,
      info.authorizedPersons
    );
    console.log('│  Pessoas autorizadas:');
    for (const p of persons) {
      console.log(`│    #${p.id} ${p.name} reg=${p.registration_number || '-'}`);
    }
  }

  if (info.authorizedVisitors.length > 0) {
    const ph = info.authorizedVisitors.map(() => '?').join(',');
    const visitors = await db.all(
      `SELECT id, name, registration_number, status FROM visitors WHERE id IN (${ph}) ORDER BY id`,
      info.authorizedVisitors
    );
    console.log('│  Visitantes autorizados:');
    for (const v of visitors) {
      console.log(`│    #${v.id} ${v.name} reg=${v.registration_number || '-'} status=${v.status}`);
    }
  }

  console.log('└─────────────────────────────────────────────');
}

console.log('\n✅ Concluído.\n');
process.exit(0);

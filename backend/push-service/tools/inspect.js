#!/usr/bin/env node
// Utilitário CLI rápido para inspecionar/alterar push no tenant.
// Uso:
//   node tools/inspect.js list-tenants
//   node tools/inspect.js tables --tenant <id>
//   node tools/inspect.js list-equip --tenant <id>
//   node tools/inspect.js enable-push --tenant <id> --validador <v> [--secret <token>]
//   node tools/inspect.js queue --tenant <id> [--limit 20]
//   node tools/inspect.js insert-fake-equip --tenant <id> --validador <v> --name <name> --ip <ip>
//   node tools/inspect.js wake --validador <v>   (chama /internal/wake)

import { getTenantDb, listTenants } from '../infrastructure/tenantDb.js';
import crypto from 'crypto';

const args = process.argv.slice(2);
const cmd = args[0];
const opts = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    opts[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i];
  }
}

async function main() {
  switch (cmd) {
    case 'list-tenants': {
      const t = await listTenants();
      console.log('Tenants:', t);
      break;
    }
    case 'tables': {
      const db = await getTenantDb(opts.tenant);
      const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      console.log(rows.map(r => r.name).join('\n'));
      break;
    }
    case 'list-equip': {
      const db = await getTenantDb(opts.tenant);
      const rows = await db.all(
        `SELECT id, name, validador, ip_address, modelo, active, push_enabled,
                push_secret IS NOT NULL AS has_secret, push_last_seen
         FROM equipments`
      );
      console.table(rows);
      break;
    }
    case 'enable-push': {
      const db = await getTenantDb(opts.tenant);
      const secret = opts.secret || crypto.randomBytes(32).toString('hex');
      const r = await db.run(
        `UPDATE equipments SET push_enabled = 1, push_secret = ? WHERE validador = ?`,
        [secret, opts.validador]
      );
      if (r.changes === 0) {
        console.error(`Nenhum equipamento com validador="${opts.validador}" no tenant "${opts.tenant}"`);
        process.exit(1);
      }
      console.log(`✅ push_enabled=1 em ${r.changes} equip.`);
      console.log(`   Secret: ${secret}`);
      console.log(`   (Anota — vai usar no set_configuration.fcgi)`);
      break;
    }
    case 'insert-fake-equip': {
      const db = await getTenantDb(opts.tenant);
      const r = await db.run(
        `INSERT INTO equipments (tenant_id, equip_id, name, modelo, ip_address, validador, tipo, active)
         VALUES (?, ?, ?, ?, ?, ?, 'facial_entrada', 1)`,
        [opts.tenant, opts.validador, opts.name || 'Teste Bancada', opts.modelo || 'iDFace', opts.ip || '0.0.0.0', opts.validador]
      );
      console.log(`✅ equipamento criado id=${r.lastID}`);
      break;
    }
    case 'queue': {
      const db = await getTenantDb(opts.tenant);
      const rows = await db.all(
        `SELECT id, device_id, endpoint, status, attempts, last_error,
                substr(body, 1, 50) AS body_preview, created_at, completed_at, origin
         FROM push_outbox ORDER BY id DESC LIMIT ?`,
        [parseInt(opts.limit || '20', 10)]
      );
      console.table(rows);
      break;
    }
    case 'enqueue-test': {
      // Insere um message_to_screen pra um device e dispara wake.
      const db = await getTenantDb(opts.tenant);
      await db.run(
        `INSERT INTO push_outbox (device_id, endpoint, body, origin)
         VALUES (?, 'message_to_screen', ?, 'manual_test')`,
        [opts.validador, JSON.stringify({ message: opts.msg || 'OLA DO PUSH', timeout: 5000 })]
      );
      console.log(`✅ enfileirado. Disparando wake...`);
      try {
        const res = await fetch('http://127.0.0.1:3001/internal/wake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: opts.validador }),
        });
        console.log(`wake: HTTP ${res.status}`, await res.json());
      } catch (e) {
        console.log(`wake falhou (Push offline?): ${e.message}`);
      }
      break;
    }
    default:
      console.log('Comandos: list-tenants | tables | list-equip | enable-push | insert-fake-equip | queue | enqueue-test');
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

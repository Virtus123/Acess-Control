/**
 * Script: reset-vehicle-status.js
 *
 * Objetivo: Corrigir inconsistências de status de veículos na base de dados.
 *
 * O que faz:
 *   1. Faz backup completo do .db de cada tenant antes de alterar
 *   2. Reseta todos os veículos para status='inactive' e parking_id=NULL
 *   3. Garante que nenhum veículo seja considerado "dentro" indevidamente
 *
 * Uso:
 *   node src/scripts/reset-vehicle-status.js              # todos os tenants
 *   node src/scripts/reset-vehicle-status.js <tenantId>   # tenant específico
 *   node src/scripts/reset-vehicle-status.js --dry-run    # só simula, não altera
 */

import 'dotenv/config';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import backupService from '../services/backupService.js';
import dbManager from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const tenantIdArg = args.find(a => a !== '--dry-run');

async function run() {
  const tenantsPath = dbManager.basePath;

  let tenants = [];

  if (tenantIdArg) {
    tenants = [tenantIdArg];
    console.log(`Alvo específico: ${tenantIdArg}`);
  } else {
    try {
      await fs.mkdir(tenantsPath, { recursive: true });
      const files = await fs.readdir(tenantsPath);
      tenants = files
        .filter(f => f.startsWith('tenant_') && f.endsWith('.db'))
        .map(f => f.replace('tenant_', '').replace('.db', ''));
      console.log(`Detectados ${tenants.length} tenant(s) em ${tenantsPath}`);
    } catch (err) {
      console.error('Erro ao ler diretório de tenants:', err.message);
      process.exit(1);
    }
  }

  if (tenants.length === 0) {
    console.log('Nenhum tenant encontrado.');
    process.exit(0);
  }

  if (isDryRun) {
    console.log('\n*** MODO DRY-RUN — nenhuma alteração será feita ***\n');
  }

  console.log('='.repeat(60));
  console.log(`Iniciando reset de status de veículos (${tenants.length} tenant(s))`);
  console.log('='.repeat(60));

  let totalVehiclesReset = 0;

  for (const tenantId of tenants) {
    try {
      if (!(await dbManager.tenantExists(tenantId))) {
        console.warn(`[${tenantId}] Banco não encontrado, pulando...`);
        continue;
      }

      console.log(`\n[${tenantId}] Processando...`);

      // 1. Backup antes de qualquer alteração
      if (!isDryRun) {
        console.log(`[${tenantId}] Fazendo backup...`);
        const backup = await backupService.createBackup(tenantId, 'manual');
        const sizeMB = (backup.size_bytes / (1024 * 1024)).toFixed(2);
        console.log(`[${tenantId}] Backup OK: ${backup.filename} (${sizeMB} MB)`);
      }

      // 2. Conectar ao banco
      const db = await dbManager.getConnection(tenantId);

      // 3. Contar veículos afetados
      const activeCount = await db.get(
        "SELECT COUNT(*) as count FROM vehicles WHERE status = 'active' OR parking_id IS NOT NULL"
      );
      const total = activeCount?.count || 0;

      console.log(`[${tenantId}] Veículos com status active ou parking_id preenchido: ${total}`);

      if (total === 0) {
        console.log(`[${tenantId}] Nenhum veículo a corrigir.`);
        continue;
      }

      // 4. Mostrar quais seriam alterados
      const affected = await db.all(
        `SELECT id, plate, status, parking_id
         FROM vehicles
         WHERE status = 'active' OR parking_id IS NOT NULL
         LIMIT 50`
      );

      console.log(`[${tenantId}] Exemplos de veículos a corrigir:`);
      affected.forEach(v => {
        console.log(`  ID ${v.id} | Placa: ${v.plate || 'N/A'} | Status: ${v.status} | parking_id: ${v.parking_id ?? 'NULL'}`);
      });
      if (total > 50) {
        console.log(`  ... e mais ${total - 50} veículos`);
      }

      // 5. Executar o reset
      if (!isDryRun) {
        await db.run(
          "UPDATE vehicles SET status = 'inactive', parking_id = NULL WHERE status = 'active' OR parking_id IS NOT NULL"
        );
        console.log(`[${tenantId}] Reset concluído: ${total} veículo(s) atualizados.`);
        totalVehiclesReset += total;
      } else {
        console.log(`[${tenantId}] [DRY-RUN] Seriam resetados: ${total} veículo(s).`);
      }

    } catch (err) {
      console.error(`[${tenantId}] ERRO: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  if (isDryRun) {
    console.log('DRY-RUN finalizado. Nenhuma alteração foi feita.');
  } else {
    console.log(`Reset finalizado. Total de veículos corrigidos: ${totalVehiclesReset}`);
  }
  console.log('='.repeat(60));

  setTimeout(() => process.exit(0), 500);
}

process.on('unhandledRejection', (reason) => {
  console.error('Erro inesperado:', reason);
  process.exit(1);
});

run();

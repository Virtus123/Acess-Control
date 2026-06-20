import 'dotenv/config';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import backupService from '../services/backupService.js';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  const tenantIdArg = process.argv[2];
  const tenantsPath = dbManager.basePath;

  let tenants = [];

  if (tenantIdArg) {
    tenants = [tenantIdArg];
    console.log(`Alvo específico selecionado: ${tenantIdArg}`);
  } else {
    try {
      // Garantir que o diretório existe
      await fs.mkdir(tenantsPath, { recursive: true });
      
      const files = await fs.readdir(tenantsPath);
      tenants = files
        .filter(f => f.startsWith('tenant_') && f.endsWith('.db'))
        .map(f => f.replace('tenant_', '').replace('.db', ''));
        
      console.log(`Detectados ${tenants.length} tenants no diretório ${tenantsPath}`);
    } catch (err) {
      console.error('Erro ao ler diretório de tenants:', err.message);
      process.exit(1);
    }
  }

  if (tenants.length === 0) {
    console.log('Nenhum tenant encontrado para backup.');
    process.exit(0);
  }

  console.log('--------------------------------------------------');
  console.log(`Iniciando backup forçado para ${tenants.length} tenant(s)`);
  console.log('--------------------------------------------------');

  for (const tenantId of tenants) {
    try {
      if (!(await dbManager.tenantExists(tenantId))) {
        console.warn(`[${tenantId}] Banco de dados não encontrado, pulando...`);
        continue;
      }

      console.log(`[${tenantId}] Processando...`);
      const startTime = Date.now();
      
      const result = await backupService.createBackup(tenantId, 'manual');
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMB = (result.size_bytes / (1024 * 1024)).toFixed(2);
      
      console.log(`[${tenantId}] OK: ${result.filename} (${sizeMB} MB) em ${duration}s`);
    } catch (err) {
      console.error(`[${tenantId}] ERRO: ${err.message}`);
      logger.error(`Erro no script de backup forçado para tenant ${tenantId}`, { error: err.message });
    }
  }

  console.log('--------------------------------------------------');
  console.log('Operação de backup finalizada.');
  console.log('--------------------------------------------------');
  
  // Aguarda um pouco para garantir que logs e streams fecharam
  setTimeout(() => process.exit(0), 1000);
}

// Trata erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

run();

import fs from 'fs/promises';
import path from 'path';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';
import 'dotenv/config';

async function main() {
  console.log('\n--- Acess Control - Cancelador de E-mails Pendentes ---\n');

  const tenantDir = process.env.DATABASE_STORAGE || './database/tenants';
  
  try {
    const files = await fs.readdir(tenantDir);
    const tenantFiles = files.filter(f => f.endsWith('.db') && f.startsWith('tenant_'));

    console.log(`Encontradas ${tenantFiles.length} unidades para verificar.\n`);

    for (const file of tenantFiles) {
      const tenantId = file.replace('tenant_', '').replace('.db', '');
      
      try {
        const db = await dbManager.getConnection(tenantId);
        
        // Verificar se a tabela email_logs existe
        const tableCheck = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='email_logs'");
        
        if (tableCheck) {
          const pendingCount = await db.get("SELECT COUNT(*) as count FROM email_logs WHERE status = 'pending'");
          
          if (pendingCount.count > 0) {
            console.log(`[${tenantId}] Cancelando ${pendingCount.count} e-mails pendentes...`);
            
            await db.run(
              "UPDATE email_logs SET status = 'cancelled', error_message = 'Cancelado manualmente pelo administrador' WHERE status = 'pending'"
            );
            
            console.log(`[${tenantId}] ✅ Sucesso.`);
          } else {
            // console.log(`[${tenantId}] Sem e-mails pendentes.`);
          }
        }
        
        await dbManager.closeConnection(tenantId);
      } catch (err) {
        console.error(`[${tenantId}] ❌ Erro: ${err.message}`);
      }
    }

    console.log('\n✅ Processo concluído.');

  } catch (error) {
    console.error(`❌ Erro ao ler diretório de tenants: ${error.message}`);
  } finally {
    process.exit();
  }
}

main();

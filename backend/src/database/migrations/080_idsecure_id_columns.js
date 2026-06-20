import logger from '../../config/logger.js';

/**
 * Migração 080: Adiciona colunas idsecure_id para rastrear vínculos com a API Cloud.
 * Isso evita duplicatas ao garantir um identificador único de origem.
 */
export async function migrate(db) {
  try {
    const tables = ['persons', 'visitors', 'companies', 'groups', 'access_log', 'equipments'];
    
    for (const tableName of tables) {
      const tableInfo = await db.all(`PRAGMA table_info('${tableName}');`);
      const existingCols = (tableInfo || []).map(c => c.name);
      
      if (!existingCols.includes('idsecure_id')) {
        logger.info(`Migração 080: Adicionando coluna 'idsecure_id' à tabela '${tableName}'`);
        await db.exec(`ALTER TABLE ${tableName} ADD COLUMN idsecure_id TEXT;`);
        
        // Criar índice para performance
        const indexName = `idx_${tableName}_idsecure_id`;
        await db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(idsecure_id);`);
      }

      if (!existingCols.includes('updated_at')) {
        logger.info(`Migração 080: Adicionando coluna 'updated_at' à tabela '${tableName}'`);
        await db.exec(`ALTER TABLE ${tableName} ADD COLUMN updated_at DATETIME DEFAULT '2024-01-01 00:00:00';`);
      }
    }

    logger.info('Migração 080: Colunas de integração iDSecure adicionadas com sucesso.');
  } catch (err) {
    logger.error('Erro na migração 080 (idsecure_id_columns):', { error: err.message });
    throw err;
  }
}

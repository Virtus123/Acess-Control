import logger from '../../config/logger.js';

/**
 * Migração 078: Correção Abrangente de Schema ( VPS Comprehensive Fix )
 * Oficializa todas as correções manuais que foram aplicadas na VPS em novos tenants.
 */
export async function migrate(db) {
  try {
    // 1. Garantir colunas em 'encomendas'
    const encomendasCols = await db.all("PRAGMA table_info('encomendas');");
    const existingEncomendas = (encomendasCols || []).map(c => c.name);
    
    const requiredEncomendas = [
      { name: 'destinatario_grupo_id', sql: "ALTER TABLE encomendas ADD COLUMN destinatario_grupo_id INTEGER;" },
      { name: 'destinatario_company_id', sql: "ALTER TABLE encomendas ADD COLUMN destinatario_company_id INTEGER;" },
      { name: 'destinatario_pessoa_id', sql: "ALTER TABLE encomendas ADD COLUMN destinatario_pessoa_id INTEGER;" },
      { name: 'assinatura_recebedor', sql: "ALTER TABLE encomendas ADD COLUMN assinatura_recebedor TEXT;" },
      { name: 'assinatura_ip', sql: "ALTER TABLE encomendas ADD COLUMN assinatura_ip TEXT;" },
      { name: 'assinatura_device', sql: "ALTER TABLE encomendas ADD COLUMN assinatura_device TEXT;" },
      { name: 'assinatura_nome_recebedor', sql: "ALTER TABLE encomendas ADD COLUMN assinatura_nome_recebedor TEXT;" },
      { name: 'data_entrega_app', sql: "ALTER TABLE encomendas ADD COLUMN data_entrega_app DATETIME;" },
      { name: 'assinatura_app', sql: "ALTER TABLE encomendas ADD COLUMN assinatura_app TEXT;" },
      { name: 'ip_recebimento', sql: "ALTER TABLE encomendas ADD COLUMN ip_recebimento TEXT;" },
      { name: 'device_recebimento', sql: "ALTER TABLE encomendas ADD COLUMN device_recebimento TEXT;" }
    ];

    for (const col of requiredEncomendas) {
      if (!existingEncomendas.includes(col.name)) {
        logger.info(`Fixing schema (078): Coluna '${col.name}' ausente em encomendas — adicionando.`);
        await db.exec(col.sql);
      }
    }

    // 2. Garantir 'access_log' e colunas ausentes
    const accessLogTables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_log'");
    const accessLogTable = accessLogTables && accessLogTables.length > 0 ? accessLogTables[0] : null;
    if (!accessLogTable) {
       logger.info('Fixing schema (078): Tabela access_log ausente — criando.');
       await db.exec(`
          CREATE TABLE access_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            person_id INTEGER NOT NULL,
            person_type TEXT NOT NULL CHECK (person_type IN ('person', 'visitor', 'vehicle')),
            vehicle_id INTEGER,
            equipment_id INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT', 'DENIED')),
            status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
            message TEXT,
            plate TEXT,
            company_id INTEGER,
            access_type TEXT DEFAULT 'PERSON',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
       `);
    } else {
       const accessLogCols = await db.all("PRAGMA table_info('access_log');");
       const existingAccessLog = (accessLogCols || []).map(c => c.name);
       
       const requiredAccessLog = [
         { name: 'vehicle_id', sql: "ALTER TABLE access_log ADD COLUMN vehicle_id INTEGER;" },
         { name: 'plate', sql: "ALTER TABLE access_log ADD COLUMN plate TEXT;" },
         { name: 'company_id', sql: "ALTER TABLE access_log ADD COLUMN company_id INTEGER;" },
         { name: 'access_type', sql: "ALTER TABLE access_log ADD COLUMN access_type TEXT DEFAULT 'PERSON';" }
       ];

       for (const col of requiredAccessLog) {
         if (!existingAccessLog.includes(col.name)) {
           logger.info(`Fixing schema (078): Coluna '${col.name}' ausente em access_log — adicionando.`);
           await db.exec(col.sql);
         }
       }
    }

    // 3. Garantir colunas em 'persons'
    const personsCols = await db.all("PRAGMA table_info('persons');");
    const existingPersons = (personsCols || []).map(c => c.name);

    if (!existingPersons.includes('password_hash')) {
      logger.info('Fixing schema (078): Coluna password_hash ausente em persons — adicionando.');
      await db.exec("ALTER TABLE persons ADD COLUMN password_hash TEXT;");
    }
    if (!existingPersons.includes('mobile_permissions')) {
      logger.info('Fixing schema (078): Coluna mobile_permissions ausente em persons — adicionando.');
      await db.exec("ALTER TABLE persons ADD COLUMN mobile_permissions TEXT DEFAULT '[\"equipments\",\"encomendas\",\"monitoramento\"]';");
    }
    if (!existingPersons.includes('role')) {
      logger.info('Fixing schema (078): Coluna role ausente em persons — adicionando.');
      await db.exec("ALTER TABLE persons ADD COLUMN role TEXT DEFAULT 'resident';");
    }
    if (!existingPersons.includes('on_premisse')) {
      logger.info('Fixing schema (078): Coluna on_premisse ausente em persons — adicionando.');
      await db.exec("ALTER TABLE persons ADD COLUMN on_premisse INTEGER DEFAULT 0;");
    }
    if (!existingPersons.includes('exited')) {
      logger.info('Fixing schema (078): Coluna exited ausente em persons — adicionando.');
      await db.exec("ALTER TABLE persons ADD COLUMN exited INTEGER DEFAULT 0;");
    }

    // 4. Garantir colunas em 'vehicles'
    const vehiclesCols = await db.all("PRAGMA table_info('vehicles');");
    const existingVehicles = (vehiclesCols || []).map(c => c.name);

    const requiredVehicles = [
      { name: 'plate', sql: "ALTER TABLE vehicles ADD COLUMN plate TEXT;" },
      { name: 'status', sql: "ALTER TABLE vehicles ADD COLUMN status TEXT DEFAULT 'inactive';" },
      { name: 'company_id', sql: "ALTER TABLE vehicles ADD COLUMN company_id INTEGER;" },
      { name: 'parking_id', sql: "ALTER TABLE vehicles ADD COLUMN parking_id INTEGER;" },
      { name: 'tag_number', sql: "ALTER TABLE vehicles ADD COLUMN tag_number TEXT;" },
      { name: 'spot_number', sql: "ALTER TABLE vehicles ADD COLUMN spot_number TEXT;" }
    ];

    for (const col of requiredVehicles) {
      if (!existingVehicles.includes(col.name)) {
        logger.info(`Fixing schema (078): Coluna '${col.name}' ausente em vehicles — adicionando.`);
        await db.exec(col.sql);
      }
    }

    logger.info('Migração 078: Schema abrangente garantido com sucesso.');
  } catch (err) {
    logger.error('Erro na migração 078 (vps_comprehensive_fix):', { error: err.message });
    throw err;
  }
}

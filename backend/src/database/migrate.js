import fs from 'fs/promises';
import path, { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const migrationsDir = join(__dirname, 'migrations');

async function getMigrationFiles() {
  const files = await fs.readdir(migrationsDir);
  return files
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'))
    .sort();
}

async function runMigrations(tenantId) {
  const db = await dbManager.getConnection(tenantId);

  // --- Fase 1: Rodar migrations SQL/JS ---
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const appliedMigrations = await db.all(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = appliedMigrations.map(m => m.version);

    const migrationFiles = await getMigrationFiles();

    for (const file of migrationFiles) {
      const version = file.replace(/\.(sql|js)$/, '');

      if (!appliedVersions.includes(version)) {
        try {
          logger.info(`Aplicando migração ${version} para tenant ${tenantId}`);

          let success = false;
          if (file.endsWith('.sql')) {
            const sql = await fs.readFile(join(migrationsDir, file), 'utf-8');
            await db.exec(sql);
            success = true;
          } else if (file.endsWith('.js')) {
            const modulePath = join(migrationsDir, file);
            const { migrate } = await import(`file://${modulePath}`);

            if (typeof migrate === 'function') {
              await migrate(db);
              success = true;
            } else {
              logger.warn(`Migração JS ${file} não exporta função 'migrate'`);
              continue;
            }
          }

          if (success) {
            await db.run(
              'INSERT INTO schema_migrations (version) VALUES (?)',
              [version]
            );
            appliedVersions.push(version);
            logger.info(`Migração ${version} aplicada com sucesso`);
          }
        } catch (migError) {
          logger.error(`Erro na migração ${version} para tenant ${tenantId}`, { error: migError.message });
          // Continuar com as próximas migrations e ensure* em vez de abortar tudo
        }
      }
    }
  } catch (error) {
    logger.error(`Erro ao executar migrações para tenant ${tenantId}`, { error: error.message });
  }

  // --- Fase 2: Safety nets (sempre rodam, mesmo se migrations falharam) ---
  try {
    await ensurePersonColumns(db);
    await ensureHolidaysColumns(db);
    await ensureVisitorsColumns(db);
    await ensureVisitorsStatusConstraint(db);
    await ensureParkingsEmpresasColumn(db);
    await ensureAccessLogTenantIdColumn(db);
    await ensureVehicleParkingFields(db);
    await ensureEquipmentsDirectionColumns(db);
    await ensureAccessTasksBiometricColumns(db);
    await ensureAccessTasksFaceRemoteConstraint(db);
    await ensureAccessLogVehicleConstraint(db);
    await ensureAccessLogVehicleFields(db);
    await ensurePersonPresenceFields(db);
    await ensureShiftNotesTable(db);
    await ensureNotificacoesTable(db);
    await ensureTenantConfigTable(db);
    await ensureCompanyRelatedTables(db);
    await ensureIdSecureIdColumns(db);
  } catch (error) {
    logger.error(`Erro nos safety nets para tenant ${tenantId}`, { error: error.message });
  }
}

async function ensurePersonColumns(db) {
  try {
    const required = [
      { name: 'street_number', sql: "ALTER TABLE persons ADD COLUMN street_number TEXT;" },
      { name: 'address_complement', sql: "ALTER TABLE persons ADD COLUMN address_complement TEXT;" },
      { name: 'nationality', sql: "ALTER TABLE persons ADD COLUMN nationality TEXT;" },
      { name: 'naturality', sql: "ALTER TABLE persons ADD COLUMN naturality TEXT;" },
      { name: 'extension', sql: "ALTER TABLE persons ADD COLUMN extension TEXT;" },
      { name: 'cellphone_ddi', sql: "ALTER TABLE persons ADD COLUMN cellphone_ddi TEXT DEFAULT '+55';" }
    ];

    const cols = await db.all("PRAGMA table_info('persons');");
    const existing = (cols || []).map(c => c.name);

    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    // Log error but don't stop migrations flow here — caller will handle if necessary
    logger.warn('Erro ao garantir colunas da tabela persons', { error: err.message });
  }
}

async function ensureHolidaysColumns(db) {
  try {
    const required = [
      { name: 'repeat_annual', sql: "ALTER TABLE holidays ADD COLUMN repeat_annual INTEGER DEFAULT 0;" }
    ];

    const cols = await db.all("PRAGMA table_info('holidays');");
    const existing = (cols || []).map(c => c.name);

    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em holidays — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir colunas da tabela holidays', { error: err.message });
  }
}

async function ensureVisitorsColumns(db) {
  try {
    const required = [
      { name: 'card_number', sql: "ALTER TABLE visitors ADD COLUMN card_number TEXT;" },
      { name: 'card_type', sql: "ALTER TABLE visitors ADD COLUMN card_type TEXT DEFAULT 'manual';" },
      { name: 'liberation_type', sql: "ALTER TABLE visitors ADD COLUMN liberation_type TEXT DEFAULT 'unica';" },
      { name: 'period_start', sql: "ALTER TABLE visitors ADD COLUMN period_start DATETIME;" },
      { name: 'period_end', sql: "ALTER TABLE visitors ADD COLUMN period_end DATETIME;" },
      { name: 'expected_exit_date', sql: "ALTER TABLE visitors ADD COLUMN expected_exit_date DATETIME;" },
      { name: 'photo_base64', sql: "ALTER TABLE visitors ADD COLUMN photo_base64 TEXT;" },
      { name: 'status', sql: "ALTER TABLE visitors ADD COLUMN status TEXT DEFAULT 'on_premises';" },
      { name: 'visited_person_id', sql: "ALTER TABLE visitors ADD COLUMN visited_person_id INTEGER REFERENCES persons(id);" },
      { name: 'visited_company_id', sql: "ALTER TABLE visitors ADD COLUMN visited_company_id INTEGER REFERENCES companies(id);" },
      { name: 'face_embedding', sql: "ALTER TABLE visitors ADD COLUMN face_embedding TEXT;" },
      { name: 'registration_number', sql: "ALTER TABLE visitors ADD COLUMN registration_number TEXT;" },
      { name: 'prevent_auto_exit', sql: "ALTER TABLE visitors ADD COLUMN prevent_auto_exit INTEGER DEFAULT 0;" },
      { name: 'tenant_id', sql: "ALTER TABLE visitors ADD COLUMN tenant_id TEXT;" }
    ];

    const cols = await db.all("PRAGMA table_info('visitors');");
    const existing = (cols || []).map(c => c.name);

    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em visitors — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir colunas da tabela visitors', { error: err.message });
  }
}

async function ensureVisitorsStatusConstraint(db) {
  try {
    const tableDef = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='visitors'");
    if (tableDef.length === 0 || !tableDef[0].sql) return;
    
    const sqlDef = tableDef[0].sql;
    if (!sqlDef.includes("'pre-registered'") && sqlDef.includes('CHECK(') && sqlDef.includes('status')) {
      logger.info("Atualizando constraint de status na tabela visitors para permitir 'inactive' e 'pre-registered'...");
      
      const createTableSql = sqlDef.replace(
        /CHECK\s*\(\s*status\s+IN\s*\([^)]+\)\s*\)/i, 
        "CHECK(status IN ('on_premises', 'exited', 'inactive', 'pre-registered'))"
      );
      
      if (createTableSql !== sqlDef) {
        // Obter colunas
        const cols = await db.all("PRAGMA table_info('visitors');");
        const existingCols = (cols || []).map(c => c.name).join(', ');
        
        await db.exec('PRAGMA foreign_keys=off;');
        await db.exec('BEGIN TRANSACTION;');
        
        await db.exec('CREATE TABLE visitors_backup_tmp AS SELECT * FROM visitors;');
        await db.exec('DROP TABLE visitors;');
        await db.exec(createTableSql);
        await db.exec(`INSERT INTO visitors (${existingCols}) SELECT ${existingCols} FROM visitors_backup_tmp;`);
        await db.exec('DROP TABLE visitors_backup_tmp;');
        
        await db.exec('CREATE INDEX IF NOT EXISTS idx_visitors_status ON visitors(status);');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_visitors_entry_date ON visitors(entry_date);');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_visitors_registration_number ON visitors(registration_number);');
        
        await db.exec('COMMIT;');
        await db.exec('PRAGMA foreign_keys=on;');
        logger.info('Tabela visitors atualizada com sucesso com constraint inactive.');
      }
    }
  } catch (err) {
    await db.exec('ROLLBACK;').catch(() => {});
    await db.exec('PRAGMA foreign_keys=on;').catch(() => {});
    logger.warn('Erro ao garantir constraint inactive na tabela visitors', { error: err.message });
  }
}

async function ensureParkingsEmpresasColumn(db) {
  try {
    const cols = await db.all("PRAGMA table_info('parkings');");
    const existing = (cols || []).map(c => c.name);
    
    if (!existing.includes('empresas')) {
      logger.info("Coluna 'empresas' ausente em parkings — adicionando.");
      await db.exec("ALTER TABLE parkings ADD COLUMN empresas TEXT DEFAULT NULL;");
    }
  } catch (err) {
    logger.warn('Erro ao garantir coluna empresas da tabela parkings', { error: err.message });
  }
}

async function ensureAccessLogTenantIdColumn(db) {
  try {
    // Verificar se a tabela access_log existe
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_log'");
    if (tables.length === 0) {
      // Tabela não existe, não precisa adicionar coluna
      return;
    }
    
    const cols = await db.all("PRAGMA table_info('access_log');");
    const existing = (cols || []).map(c => c.name);
    
    if (!existing.includes('tenant_id')) {
      logger.info("Coluna 'tenant_id' ausente em access_log — adicionando.");
      await db.exec("ALTER TABLE access_log ADD COLUMN tenant_id TEXT;");
    }
  } catch (err) {
    logger.warn('Erro ao garantir coluna tenant_id da tabela access_log', { error: err.message });
  }
}

async function ensureVehicleParkingFields(db) {
  try {
    // Verificar se a tabela vehicles existe
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='vehicles'");
    if (tables.length === 0) {
      // Tabela não existe
      return;
    }
    
    const cols = await db.all("PRAGMA table_info('vehicles');");
    const existing = (cols || []).map(c => c.name);
    
    // Nota: company_id e parking_id já são criados na migração 027
    // Aqui garantimos apenas os campos adicionais: plate e status
    const required = [
      { name: 'plate', sql: "ALTER TABLE vehicles ADD COLUMN plate TEXT;" },
      { name: 'status', sql: "ALTER TABLE vehicles ADD COLUMN status TEXT DEFAULT 'inactive';" },
      { name: 'observacao', sql: "ALTER TABLE vehicles ADD COLUMN observacao TEXT;" }
    ];
    
    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em vehicles — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir campos de estacionamento da tabela vehicles', { error: err.message });
  }
}

async function ensureEquipmentsDirectionColumns(db) {
  try {
    // Verificar se a tabela equipments existe
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='equipments'");
    if (tables.length === 0) {
      return;
    }
    
    const cols = await db.all("PRAGMA table_info('equipments');");
    const existing = (cols || []).map(c => c.name);
    
    const required = [
      { name: 'direction_entrada', sql: "ALTER TABLE equipments ADD COLUMN direction_entrada TEXT;" },
      { name: 'direction_saida', sql: "ALTER TABLE equipments ADD COLUMN direction_saida TEXT;" }
    ];
    
    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em equipments — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir colunas de direção da tabela equipments', { error: err.message });
  }
}

// Função para garantir colunas biométricas na tabela access_tasks
async function ensureAccessTasksBiometricColumns(db) {
  try {
    // Verificar se a tabela access_tasks existe
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_tasks'");
    if (tables.length === 0) {
      return;
    }
    
    const cols = await db.all("PRAGMA table_info('access_tasks');");
    const existing = (cols || []).map(c => c.name);
    
    const required = [
      { name: 'person_id', sql: "ALTER TABLE access_tasks ADD COLUMN person_id INTEGER;" },
      { name: 'finger_type', sql: "ALTER TABLE access_tasks ADD COLUMN finger_type TEXT;" },
      { name: 'callback_url', sql: "ALTER TABLE access_tasks ADD COLUMN callback_url TEXT;" },
      { name: 'target_type', sql: "ALTER TABLE access_tasks ADD COLUMN target_type TEXT;" },
      { name: 'target_id', sql: "ALTER TABLE access_tasks ADD COLUMN target_id INTEGER;" },
      { name: 'description', sql: "ALTER TABLE access_tasks ADD COLUMN description TEXT;" }
    ];
    
    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em access_tasks — adicionando.`);
        await db.exec(col.sql);
      }
    }
    
    // Verificar se o CHECK constraint permite template_remote, delete_visitor e delete_person
    // SQLite não suporta ALTER TABLE para constraints, então precisamos recriar a tabela
    const tableDef = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='access_tasks'");
    const needsRecreation = tableDef.length > 0 && (
      !tableDef[0].sql.includes('template_remote') || 
      !tableDef[0].sql.includes('delete_visitor') || 
      !tableDef[0].sql.includes('delete_person')
    );
    
    if (needsRecreation) {
      logger.info('CHECK constraint não permite os novos tipos de tarefa — recriando tabela.');
      
      // Backup dos dados
      const oldData = await db.all('SELECT * FROM access_tasks');
      
      // Dropar e recriar com nova constraint
      await db.exec('DROP TABLE IF EXISTS access_tasks_new;');
      await db.exec(`
        CREATE TABLE access_tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          equip_validator TEXT NOT NULL,
          task_type TEXT NOT NULL CHECK(task_type IN ('emergencia', 'liberar_acesso', 'template_remote', 'delete_visitor', 'delete_person', 'sync_person')),
          status INTEGER DEFAULT 1,
          resolved INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME,
          resolved_by TEXT,
          person_id INTEGER,
          callback_url TEXT,
          finger_type TEXT,
          target_type TEXT,
          target_id INTEGER,
          description TEXT
        );
      `);
      
      // Copiar dados
      if (oldData.length > 0) {
        for (const row of oldData) {
          await db.run(
            `INSERT INTO access_tasks_new (id, tenant_id, equip_validator, task_type, status, resolved, created_at, resolved_at, resolved_by, person_id, callback_url, finger_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.id, row.tenant_id, row.equip_validator, row.task_type, row.status, row.resolved, row.created_at, row.resolved_at, row.resolved_by, row.person_id, row.callback_url, row.finger_type]
          );
        }
      }
      
      await db.exec('DROP TABLE access_tasks;');
      await db.exec('ALTER TABLE access_tasks_new RENAME TO access_tasks;');
      
      // Recriar índices
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved);');
      
      logger.info('Tabela access_tasks atualizada com sucesso.');
    }
    
  } catch (err) {
    logger.warn('Erro ao garantir colunas biométricas da tabela access_tasks', { error: err.message });
  }
}

async function ensureAccessTasksFaceRemoteConstraint(db) {
  try {
    const tableDef = await db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='access_tasks'");
    if (tableDef.length === 0 || !tableDef[0].sql) return;
    
    const sqlDef = tableDef[0].sql;
    if (!sqlDef.includes('face_remote')) {
      logger.info('CHECK constraint de access_tasks não permite face_remote — recriando tabela para atualizar.');
      
      // Obter colunas
      const cols = await db.all("PRAGMA table_info('access_tasks');");
      const existingCols = (cols || []).map(c => c.name).join(', ');
      
      const newTableSql = `
        CREATE TABLE access_tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          equip_validator TEXT NOT NULL,
          task_type TEXT NOT NULL CHECK(task_type IN ('emergencia', 'liberar_acesso', 'template_remote', 'delete_visitor', 'delete_person', 'sync_person', 'face_remote', 'face_remote_capture')),
          status TEXT DEFAULT 'pending',
          resolved INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME,
          resolved_by TEXT,
          person_id INTEGER,
          visitor_id INTEGER,
          person_type TEXT DEFAULT 'person',
          description TEXT,
          result_data TEXT,
          error TEXT,
          target_type TEXT,
          target_id TEXT,
          callback_url TEXT,
          finger_type TEXT
        );
      `;

      await db.exec('PRAGMA foreign_keys=off;');
      await db.exec('BEGIN TRANSACTION;');
      
      await db.exec(newTableSql);
      
      // Mapear colunas existentes para as novas para evitar erro se alguma coluna faltar
      const insertCols = (cols || []).map(c => c.name).filter(name => ![].includes(name)).join(', ');
      await db.exec(`INSERT INTO access_tasks_new (${insertCols}) SELECT ${insertCols} FROM access_tasks;`);
      
      await db.exec('DROP TABLE access_tasks;');
      await db.exec('ALTER TABLE access_tasks_new RENAME TO access_tasks;');
      
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_tenant ON access_tasks(tenant_id);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_validator ON access_tasks(equip_validator);');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_tasks_status ON access_tasks(status, resolved);');
      
      await db.exec('COMMIT;');
      await db.exec('PRAGMA foreign_keys=on;');
      logger.info('Tabela access_tasks atualizada com sucesso para Face Remote.');
    }
  } catch (err) {
    await db.exec('ROLLBACK;').catch(() => {});
    await db.exec('PRAGMA foreign_keys=on;').catch(() => {});
    logger.warn('Erro ao garantir constraint Face Remote na tabela access_tasks', { error: err.message });
  }
}

// Função para garantir que a constraint de person_type aceita 'vehicle'
async function ensureAccessLogVehicleConstraint(db) {
  try {
    // Primeiro, verificar e remover tabelas órfãs de migrações anteriores
    try {
      await db.exec('DROP TABLE IF EXISTS access_log_new');
    } catch (e) { /* ignore */ }
    
    try {
      await db.exec('DROP TABLE IF EXISTS visitors_old');
    } catch (e) { /* ignore */ }
    
    // Verificar a estrutura atual da tabela
    const columns = await db.all("PRAGMA table_info(access_log)");
    const hasVehicleColumn = columns.some(c => c.name === 'vehicle_id');
    
    // Testar se 'vehicle' é aceito
    let acceptsVehicle = false;
    try {
      await db.run(
        "INSERT INTO access_log (tenant_id, person_id, person_type, equipment_id, action, status, message) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ['test_tenant', 1, 'vehicle', 1, 'ENTRY', 'SUCCESS', 'test']
      );
      // Se funcionou, cleanup
      await db.run("DELETE FROM access_log WHERE message = 'test'");
      acceptsVehicle = true;
    } catch (testErr) {
      acceptsVehicle = false;
    }
    
    if (!acceptsVehicle) {
      logger.info('Corrigindo constraint person_type para aceitar vehicle...');
      
      // Backup dos dados
      const backup = await db.all('SELECT * FROM access_log');
      
      // Verificar se tem vehicle_id
      const hasVehicleId = columns.some(c => c.name === 'vehicle_id');
      
      // Dropar e recriar
      await db.exec('DROP TABLE IF EXISTS access_log_new');
      
      if (hasVehicleId) {
        await db.exec(`
          CREATE TABLE access_log_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            person_id INTEGER NOT NULL,
            person_type TEXT NOT NULL CHECK (person_type IN ('person', 'visitor', 'vehicle')),
            vehicle_id INTEGER,
            equipment_id INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT', 'DENIED')),
            status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
            message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (equipment_id) REFERENCES equipments(id),
            FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
          )
        `);
      } else {
        await db.exec(`
          CREATE TABLE access_log_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id TEXT NOT NULL,
            person_id INTEGER NOT NULL,
            person_type TEXT NOT NULL CHECK (person_type IN ('person', 'visitor', 'vehicle')),
            equipment_id INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT', 'DENIED')),
            status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
            message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (equipment_id) REFERENCES equipments(id)
          )
        `);
      }
      
      // Copiar dados
      if (backup.length > 0) {
        for (const row of backup) {
          if (hasVehicleId && row.vehicle_id !== undefined) {
            await db.run(
              `INSERT INTO access_log_new (id, tenant_id, person_id, person_type, vehicle_id, equipment_id, action, status, message, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [row.id, row.tenant_id, row.person_id, row.person_type, row.vehicle_id, row.equipment_id, row.action, row.status, row.message, row.created_at]
            );
          } else {
            await db.run(
              `INSERT INTO access_log_new (id, tenant_id, person_id, person_type, equipment_id, action, status, message, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [row.id, row.tenant_id, row.person_id, row.person_type, row.equipment_id, row.action, row.status, row.message, row.created_at]
            );
          }
        }
      }
      
      await db.exec('DROP TABLE access_log');
      await db.exec('ALTER TABLE access_log_new RENAME TO access_log');
      
      // Recriar índices
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_log_tenant ON access_log(tenant_id, created_at DESC)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_log_person ON access_log(person_id, person_type)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_log_equipment ON access_log(equipment_id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_access_log_status ON access_log(status)');
      if (hasVehicleId) {
        await db.exec('CREATE INDEX IF NOT EXISTS idx_access_log_vehicle ON access_log(vehicle_id)');
      }
      
      logger.info('Constraint person_type atualizada com sucesso');
    }
    
  } catch (err) {
    logger.warn('Erro ao garantir constraint vehicle na tabela access_log', { error: err.message });
  }
}

// Função para garantir campos de veículo na tabela access_log
async function ensureAccessLogVehicleFields(db) {
  try {
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_log'");
    if (tables.length === 0) return;
    
    const cols = await db.all("PRAGMA table_info('access_log');");
    const existing = (cols || []).map(c => c.name);
    
    const required = [
      { name: 'vehicle_id', sql: "ALTER TABLE access_log ADD COLUMN vehicle_id INTEGER;" },
      { name: 'plate', sql: "ALTER TABLE access_log ADD COLUMN plate TEXT;" },
      { name: 'company_id', sql: "ALTER TABLE access_log ADD COLUMN company_id INTEGER;" },
      { name: 'access_type', sql: "ALTER TABLE access_log ADD COLUMN access_type TEXT DEFAULT 'PERSON';" }
    ];
    
    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em access_log — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir campos de veículo na tabela access_log', { error: err.message });
  }
}

// Função para garantir campos de presença na tabela persons
async function ensurePersonPresenceFields(db) {
  try {
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='persons'");
    if (tables.length === 0) return;
    
    const cols = await db.all("PRAGMA table_info('persons');");
    const existing = (cols || []).map(c => c.name);
    
    const required = [
      { name: 'on_premisse', sql: "ALTER TABLE persons ADD COLUMN on_premisse INTEGER DEFAULT 0;" },
      { name: 'exited', sql: "ALTER TABLE persons ADD COLUMN exited INTEGER DEFAULT 0;" }
    ];
    
    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Coluna '${col.name}' ausente em persons — adicionando.`);
        await db.exec(col.sql);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir campos de presença na tabela persons', { error: err.message });
  }
}

async function ensureShiftNotesTable(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS shift_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        author_label TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_shift_notes_tenant_created ON shift_notes(tenant_id, created_at DESC);
    `);
  } catch (err) {
    logger.warn('Erro ao garantir tabela shift_notes', { error: err.message });
  }
}

async function ensureNotificacoesTable(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS notificacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo_evento TEXT NOT NULL,
        grupos TEXT DEFAULT '[]',
        assunto TEXT NOT NULL,
        corpo TEXT NOT NULL,
        ativo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_notificacoes_evento ON notificacoes(tipo_evento, ativo);
    `);
    // logger.info('Tabela notificacoes garantida com sucesso.');
  } catch (err) {
    logger.warn('Erro ao garantir tabela notificacoes', { error: err.message });
  }
}

async function ensureTenantConfigTable(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    // logger.info('Tabela tenant_config garantida com sucesso.');
  } catch (err) {
    logger.warn('Erro ao garantir tabela tenant_config', { error: err.message });
  }
}

async function ensureCompanyRelatedTables(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS company_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE(company_id, group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_company_groups_company ON company_groups(company_id);
      CREATE INDEX IF NOT EXISTS idx_company_groups_group ON company_groups(group_id);
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS company_notification_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_company_notifications_company_id ON company_notification_emails(company_id);
    `);
  } catch (err) {
    logger.warn('Erro ao garantir tabelas company_groups/company_notification_emails', { error: err.message });
  }
}

async function ensureIdSecureIdColumns(db) {
  try {
    const entities = ['persons', 'visitors', 'companies', 'groups', 'access_log', 'equipments'];
    for (const entity of entities) {
      const info = await db.all(`PRAGMA table_info('${entity}');`);
      const cols = (info || []).map(c => c.name);
      if (!cols.includes('idsecure_id')) {
        logger.info(`Fixing schema: Adding 'idsecure_id' to ${entity}`);
        await db.exec(`ALTER TABLE ${entity} ADD COLUMN idsecure_id TEXT;`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_${entity}_idsecure_id ON ${entity}(idsecure_id);`);
      }
      if (!cols.includes('updated_at')) {
        logger.info(`Fixing schema: Adding 'updated_at' to ${entity}`);
        await db.exec(`ALTER TABLE ${entity} ADD COLUMN updated_at DATETIME DEFAULT '2024-01-01 00:00:00';`);
      }
    }
  } catch (err) {
    logger.warn('Erro ao garantir colunas idsecure_id', { error: err.message });
  }
}

const isMain = process.argv[1] && 
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) || 
   fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase());

if (isMain) {
  const tenantId = process.argv[2] || 'default';
  runMigrations(tenantId)
    .then(() => {
      console.log(`Migrações concluídas para tenant: ${tenantId}`);
      process.exit(0);
    })
    .catch(error => {
      console.error('Erro ao executar migrações:', error);
      process.exit(1);
    });
}

export { runMigrations };




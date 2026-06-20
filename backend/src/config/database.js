import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DatabaseManager {
  constructor() {
    this.connections = new Map();
    // Set de tenants cuja estrutura já foi verificada nesta execução do servidor.
    // Evita rodar PRAGMA table_info / ALTER TABLE em todo request (hot path).
    this.verifiedTenants = new Set();
    // Use __dirname to find the database folder relative to this source file
    // src/config/database.js -> ../../database/tenants
    this.basePath = process.env.DATABASE_STORAGE || join(__dirname, '..', '..', 'database', 'tenants');
  }

  async init() {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  getTenantPath(tenantId) {
    return join(this.basePath, `tenant_${tenantId}.db`);
  }

  async getConnection(tenantId) {
    // Hot path: conexão já existe e estrutura já foi verificada → retorna direto
    if (this.connections.has(tenantId)) {
      return this.connections.get(tenantId);
    }

    const dbPath = this.getTenantPath(tenantId);
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Database connection error:', err);
        throw err;
      }
    });

    const runPragma = (sql) => new Promise((resolve, reject) => {
      db.run(sql, (err) => err ? reject(err) : resolve());
    });

    // Configurações de performance para SQLite
    await runPragma('PRAGMA encoding = "UTF-8"');
    // WAL mode: leitores não bloqueiam escritores
    await runPragma('PRAGMA journal_mode=WAL');
    // synchronous=NORMAL: balance entre durabilidade e velocidade
    await runPragma('PRAGMA synchronous=NORMAL');
    // Cache de 64MB
    await runPragma('PRAGMA cache_size=-64000');
    // Tabelas temporárias em memória (evita I/O disco para sorts/joins)
    await runPragma('PRAGMA temp_store=memory');
    // Memory-mapped I/O de 256MB (SQLite lê páginas direto da memória)
    await runPragma('PRAGMA mmap_size=268435456');
    // Espera até 5s se houver lock antes de retornar SQLITE_BUSY
    await runPragma('PRAGMA busy_timeout=5000');

    // Função personalizada para run que retorna lastID
    const runWithLastID = (sql, params) => {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ lastID: this.lastID, changes: this.changes });
          }
        });
      });
    };

    const dbAsync = {
      get: promisify(db.get.bind(db)),
      all: promisify(db.all.bind(db)),
      run: runWithLastID,
      exec: promisify(db.exec.bind(db)),
      close: promisify(db.close.bind(db))
    };

    this.connections.set(tenantId, dbAsync);

    // Verificações estruturais e índices: rodam UMA VEZ por execução do servidor,
    // na primeira vez que abrimos a conexão deste tenant. Não rodam em hot path.
    if (!this.verifiedTenants.has(tenantId)) {
      await this.ensureAccessLogTenantIdColumn(dbAsync);
      await this.ensureAuditLogUserNameColumn(dbAsync);
      await this.ensureAccessTasksFaceRemoteColumns(dbAsync);
      await this.ensurePerformanceIndexes(dbAsync);
      await this.ensurePushOutboxSchema(dbAsync);
      this.verifiedTenants.add(tenantId);
    }

    return dbAsync;
  }

  // Cria índices críticos para performance do autorizador.
  // CREATE INDEX IF NOT EXISTS é idempotente — seguro rodar em todos os tenants.
  async ensurePerformanceIndexes(dbAsync) {
    const indexes = [
      // Lookup de identidade (matrícula → id) — caminho mais quente do autorizador
      "CREATE INDEX IF NOT EXISTS idx_persons_registration ON persons(registration_number)",
      "CREATE INDEX IF NOT EXISTS idx_visitors_registration ON visitors(registration_number)",
      // Listagem de logs por tenant ordenada por data
      "CREATE INDEX IF NOT EXISTS idx_access_log_created ON access_log(created_at DESC)",
      // Equipamento por validador (já tem índice implícito por UNIQUE em alguns schemas, mas garantir)
      "CREATE INDEX IF NOT EXISTS idx_equipments_validador ON equipments(validador)",
      // Veículos por pessoa
      "CREATE INDEX IF NOT EXISTS idx_vehicles_person ON vehicles(person_id)",
      // Regras ativas
      "CREATE INDEX IF NOT EXISTS idx_access_rules_active ON access_rules(active)",
    ];

    for (const sql of indexes) {
      try {
        await dbAsync.exec(sql);
      } catch (err) {
        // Tabela pode não existir ainda em tenant novo — ignorar
      }
    }
  }

  // Verifica e adiciona a coluna tenant_id na tabela access_log
  async ensureAccessLogTenantIdColumn(dbAsync) {
    try {
      // Verificar se a tabela access_log existe
      const tables = await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_log'");
      if (tables.length === 0) {
        // Tabela não existe, não precisa adicionar coluna
        return;
      }
      
      const cols = await dbAsync.all("PRAGMA table_info('access_log');");
      const existing = (cols || []).map(c => c.name);
      
      if (!existing.includes('tenant_id')) {
        console.log("Coluna 'tenant_id' ausente em access_log — adicionando (on-demand).");
        await dbAsync.exec("ALTER TABLE access_log ADD COLUMN tenant_id TEXT;");
        console.log("Coluna 'tenant_id' adicionada com sucesso!");
      }
    } catch (err) {
      // Não logar erro para evitar spam - a query vai falhar se a coluna não existir
    }
  }

  // Verifica e adiciona a coluna user_name na tabela audit_logs
  async ensureAuditLogUserNameColumn(dbAsync) {
    try {
      const tables = await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'");
      if (tables.length === 0) return;
      
      const cols = await dbAsync.all("PRAGMA table_info('audit_logs');");
      const existing = (cols || []).map(c => c.name);
      
      if (!existing.includes('user_name')) {
        console.log("Coluna 'user_name' ausente em audit_logs — adicionando.");
        await dbAsync.exec("ALTER TABLE audit_logs ADD COLUMN user_name TEXT;");
        console.log("Coluna 'user_name' adicionada com sucesso!");
      }
    } catch (err) {
      // Ignorar
    }
  }

  // Verifica e adiciona colunas de Face Remote na tabela access_tasks
  async ensureAccessTasksFaceRemoteColumns(dbAsync) {
    try {
      const tables = await dbAsync.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_tasks'");
      if (tables.length === 0) return;
      
      const cols = await dbAsync.all("PRAGMA table_info('access_tasks');");
      const existing = (cols || []).map(c => c.name);
      
      if (!existing.includes('visitor_id')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN visitor_id INTEGER;");
      }
      if (!existing.includes('person_type')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN person_type TEXT DEFAULT 'person';");
      }
      if (!existing.includes('error')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN error TEXT;");
      }
      if (!existing.includes('status')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN status TEXT DEFAULT 'pending';");
      }
      if (!existing.includes('result_data')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN result_data TEXT;");
      }
      if (!existing.includes('description')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN description TEXT;");
      }
      if (!existing.includes('payload')) {
        await dbAsync.exec("ALTER TABLE access_tasks ADD COLUMN payload TEXT;");
      }
    } catch (err) {
      // Ignorar
    }
  }

  // Cria tabelas push_outbox/push_outbox_log e colunas push_* em equipments.
  // Idempotente — seguro rodar todo restart de servidor.
  async ensurePushOutboxSchema(dbAsync) {
    try {
      await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS push_outbox (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id     TEXT NOT NULL,
          endpoint      TEXT NOT NULL,
          verb          TEXT NOT NULL DEFAULT 'POST',
          body          TEXT,
          query_string  TEXT,
          content_type  TEXT DEFAULT 'application/json',
          batch_id      TEXT,
          batch_order   INTEGER DEFAULT 0,
          status        TEXT NOT NULL DEFAULT 'pending',
          attempts      INTEGER NOT NULL DEFAULT 0,
          max_attempts  INTEGER NOT NULL DEFAULT 5,
          last_error    TEXT,
          origin        TEXT,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          picked_at     DATETIME,
          completed_at  DATETIME,
          uuid          TEXT
        )
      `);

      await dbAsync.exec(`
        CREATE TABLE IF NOT EXISTS push_outbox_log (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          outbox_id     INTEGER NOT NULL,
          device_id     TEXT NOT NULL,
          event         TEXT NOT NULL,
          uuid          TEXT,
          http_status   INTEGER,
          response      TEXT,
          error         TEXT,
          duration_ms   INTEGER,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await dbAsync.exec(`CREATE INDEX IF NOT EXISTS idx_push_outbox_pending
        ON push_outbox(device_id, status, batch_id, batch_order, id)`);
      await dbAsync.exec(`CREATE INDEX IF NOT EXISTS idx_push_outbox_uuid
        ON push_outbox(uuid)`);
      await dbAsync.exec(`CREATE INDEX IF NOT EXISTS idx_push_outbox_log_device
        ON push_outbox_log(device_id, created_at DESC)`);

      const alters = [
        'ALTER TABLE equipments ADD COLUMN push_enabled INTEGER DEFAULT 0',
        'ALTER TABLE equipments ADD COLUMN push_secret TEXT',
        'ALTER TABLE equipments ADD COLUMN push_last_seen DATETIME',
        // Bridge entre push_outbox e modelo legado (sync queue + access_tasks)
        'ALTER TABLE push_outbox ADD COLUMN source_task_id INTEGER',
        'ALTER TABLE push_outbox ADD COLUMN source_sync_id INTEGER',
      ];
      for (const sql of alters) {
        try { await dbAsync.exec(sql); }
        catch (err) {
          if (!/duplicate column/i.test(err.message)) {
            console.warn('[push_outbox alter]', err.message);
          }
        }
      }
    } catch (err) {
      console.error('[ensurePushOutboxSchema] erro:', err.message);
      // não relança — não deve impedir tenant de subir
    }
  }

  // Conexão "system" / master — usada pelo M-Panel administrativo para acessar
  // tabelas globais como `revendas`, `tenant_limits`, etc. que residem no tenant
  // master `mamcontrolmam`. Reusa o pool de conexões normal.
  async getSystemConnection() {
    return this.getConnection('mamcontrolmam');
  }

  // No-op: conexões são poolizadas, fechá-las quebraria outros consumidores.
  // Mantido apenas por compatibilidade com chamadas existentes (try/finally).
  async closeSystemConnection() {
    // intencionalmente vazio
  }

  async closeConnection(tenantId) {
    const db = this.connections.get(tenantId);
    if (db) {
      await db.close();
      this.connections.delete(tenantId);
      this.verifiedTenants.delete(tenantId);
    }
  }

  async closeAll() {
    for (const [tenantId] of this.connections) {
      await this.closeConnection(tenantId);
    }
  }

  async executeMigration(tenantId, sql) {
    const db = await this.getConnection(tenantId);
    await db.exec(sql);
  }

  async listTenants() {
    try {
      const files = await fs.readdir(this.basePath);
      return files
        .filter(f => f.startsWith('tenant_') && f.endsWith('.db'))
        .map(f => f.slice('tenant_'.length, -'.db'.length));
    } catch {
      return [];
    }
  }

  async tenantExists(tenantId) {
    const dbPath = this.getTenantPath(tenantId);
    try {
      await fs.access(dbPath);
      return true;
    } catch {
      return false;
    }
  }

  async createTenant(tenantId) {
    const dbPath = this.getTenantPath(tenantId);
    const db = await this.getConnection(tenantId);
    const { runMigrations } = await import('../database/migrate.js');
    await runMigrations(tenantId);
    return dbPath;
  }

  async getInitialSchema() {
    const schemaPath = join(__dirname, '..', 'database', 'migrations', '001_initial.sql');
    return await fs.readFile(schemaPath, 'utf-8');
  }
}

export default new DatabaseManager();

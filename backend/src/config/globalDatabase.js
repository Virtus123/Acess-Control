import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { join } from 'path';
import fs from 'fs/promises';

class GlobalDatabase {
  constructor() {
    this.db = null;
    this.dbPath = join(process.cwd(), 'database', 'global_notifications.db');
  }

  async init() {
    // Garantir que o diretório existe
    const dir = join(process.cwd(), 'database');
    await fs.mkdir(dir, { recursive: true });

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error('Global database connection error:', err);
          reject(err);
          return;
        }
        
        // Configurar UTF-8
        this.db.run('PRAGMA encoding = "UTF-8"');
        
        // Inicializar tabelas
        this.initTables();
        resolve(this.db);
      });
    });
  }

  initTables() {
    // Tabela de notificações globais
    this.db.run(`
      CREATE TABLE IF NOT EXISTS global_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        is_prioritary INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        created_by TEXT DEFAULT 'Admin Master'
      )
    `);
    
    // Tabela de controle de leitura por tenant
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notification_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        notification_id INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(notification_id, tenant_id)
      )
    `);

    // Tabela de administradores globais (Plano 2.1)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('super_admin', 'support', 'revenda')),
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Adicionar colunas se não existirem (para bancos existentes)
    // Primeiro verificamos se a coluna existe
    this.db.all("PRAGMA table_info(global_notifications)", [], (err, columns) => {
      if (!err && columns) {
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('is_prioritary')) {
          this.db.run(`ALTER TABLE global_notifications ADD COLUMN is_prioritary INTEGER DEFAULT 0`);
        }
        // Remove old is_read column if exists (we'll use the new table instead)
      }
    });
  }

  // Métodos utilitários para promisify
  get(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  run(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  async close() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

// Singleton instance
const globalDb = new GlobalDatabase();

export default globalDb;

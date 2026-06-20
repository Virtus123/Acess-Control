import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { join } from 'path';
import fs from 'fs/promises';

const dbPath = join(process.cwd(), 'database', 'security.db');

class SecurityDatabase {
  constructor() {
    this.db = null;
  }

  async init() {
    await fs.mkdir(join(process.cwd(), 'database'), { recursive: true });
    
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) return reject(err);
        this.createSchema().then(resolve).catch(reject);
      });
    });
  }

  async createSchema() {
    const schema = `
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT,
        identifier TEXT,
        attempts INTEGER DEFAULT 1,
        last_attempt DATETIME DEFAULT CURRENT_TIMESTAMP,
        delay_until DATETIME,
        UNIQUE(ip, identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_id ON login_attempts(ip, identifier);
    `;
    return new Promise((resolve, reject) => {
      this.db.exec(schema, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getAttempt(ip, identifier) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM login_attempts WHERE ip = ? OR identifier = ?',
        [ip, identifier],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async recordFailure(ip, identifier) {
    const now = new Date();
    const row = await this.getAttempt(ip, identifier);
    
    let attempts = 1;
    let delayMs = 0;

    if (row) {
      attempts = row.attempts + 1;
      // Progressive delay: 1s, 2s, 4s, 8s, 16s... up to 1 hour
      delayMs = Math.min(Math.pow(2, attempts - 1) * 1000, 3600000);
    }

    const delayUntil = new Date(now.getTime() + delayMs);

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO login_attempts (ip, identifier, attempts, last_attempt, delay_until)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(ip, identifier) DO UPDATE SET
         attempts = attempts + 1,
         last_attempt = CURRENT_TIMESTAMP,
         delay_until = ?`,
        [ip, identifier, attempts, delayUntil.toISOString(), delayUntil.toISOString()],
        (err) => {
          if (err) reject(err);
          else resolve({ attempts, delayUntil });
        }
      );
    });
  }

  async resetAttempts(ip, identifier) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM login_attempts WHERE ip = ? OR identifier = ?',
        [ip, identifier],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
}

const securityDb = new SecurityDatabase();
export default securityDb;

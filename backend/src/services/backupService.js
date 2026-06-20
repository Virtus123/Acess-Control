import archiver from 'archiver';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);



class BackupService {
  constructor() {
    this.backupDir = join(process.cwd(), 'public', 'backups');
    this.retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;
  }

  async init() {
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  async createBackup(tenantId, type = 'automatic', userId = null) {
    try {
      await this.init();

      const dateStr = new Date().toISOString().split('T')[0]; // ex: 2026-03-23
      const filename = `backup_${tenantId}_${dateStr}.zip`;
      const filePath = join(this.backupDir, filename);

      // Remove o arquivo do dia, se já existir, antes de recriar
      try {
        await fs.unlink(filePath);
        logger.info(`Backup anterior removido antes de recriar: ${filename}`);
      } catch {
        // Arquivo não existia ainda — tudo bem
      }

      const output = createWriteStream(filePath);

      // Compressão máxima apenas para dados que valem a pena comprimir.
      // Arquivos já comprimidos (imagens etc.) usam STORE — ver _addTenantFilesFromDir.
      const archive = archiver('zip', { zlib: { level: 9 } });

      return new Promise((resolve, reject) => {
        output.on('close', async () => {
          try {
            const stats = await fs.stat(filePath);
            const sizeBytes = stats.size;

            const db = await dbManager.getConnection(tenantId);

            // Evita duplicata no banco para o mesmo filename
            await db.run('DELETE FROM backups WHERE filename = ?', [filename]);

            const result = await db.run(
              `INSERT INTO backups (filename, size_bytes, backup_type, created_by, file_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [filename, sizeBytes, type, userId, filePath, new Date().toISOString()]
            );

            logger.info(`Backup criado: ${filename}`, { tenantId, sizeBytes });

            // Limpeza APÓS registrar o novo backup
            await this.cleanOldBackups(tenantId);

            resolve({
              id: result.lastID,
              filename,
              size_bytes: sizeBytes,
              file_path: filePath,
              created_at: new Date().toISOString()
            });
          } catch (error) {
            reject(error);
          }
        });

        archive.on('error', reject);
        archive.pipe(output);

        (async () => {
          try {
            // Banco de dados do tenant
            const dbPath = dbManager.getTenantPath(tenantId);
            try {
              await fs.access(dbPath);
              archive.file(dbPath, { name: `database/tenant_${tenantId}.db` });
            } catch { }

            const meta = {
              version: '1.0.0',
              tenant_id: tenantId,
              date: new Date().toISOString(),
              type
            };
            archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });

            archive.finalize();
          } catch (error) {
            reject(error);
          }
        })();
      });
    } catch (error) {
      logger.error('Erro ao criar backup', { tenantId, error: error.message });
      throw error;
    }
  }

  async createManualBackup(tenantId, userId) {
    return this.createBackup(tenantId, 'manual', userId);
  }

  async createAutomaticBackup(tenantId) {
    return this.createBackup(tenantId, 'automatic', null);
  }

  /**
   * Mantém apenas o backup mais recente de cada tenant.
   * Remove do banco E do disco qualquer registro mais antigo.
   * Também varre a pasta física para apagar arquivos órfãos
   * (arquivos presentes no disco mas sem registro no banco).
   */
  async cleanOldBackups(tenantId) {
    try {
      const db = await dbManager.getConnection(tenantId);

      // ── 1. Apaga registros + arquivos além do mais recente ──────────────────
      const allBackups = await db.all(
        'SELECT id, filename, file_path FROM backups ORDER BY created_at DESC'
      );

      // O primeiro é o mais recente — todos os demais devem ser removidos
      const toDelete = allBackups.slice(1);

      for (const backup of toDelete) {
        try {
          if (backup.file_path) {
            const exists = await fs.access(backup.file_path).then(() => true).catch(() => false);
            if (exists) {
              await fs.unlink(backup.file_path);
              logger.info(`Arquivo de backup removido: ${backup.file_path}`);
            }
          }
          await db.run('DELETE FROM backups WHERE id = ?', [backup.id]);
          logger.info(`Registro de backup removido do banco: id=${backup.id}`);
        } catch (error) {
          logger.error('Erro ao remover backup antigo', { id: backup.id, error: error.message });
        }
      }

      // ── 2. Remove arquivos órfãos na pasta (sem registro no banco) ──────────
      const knownFilenames = new Set(allBackups.map(b => b.filename));
      let diskFiles;
      try {
        diskFiles = await fs.readdir(this.backupDir);
      } catch {
        return;
      }

      const tenantPattern = `backup_${tenantId}_`;
      for (const file of diskFiles) {
        if (!file.startsWith(tenantPattern)) continue; // não é desse tenant
        if (knownFilenames.has(file)) continue;        // está no banco, ok

        const orphanPath = join(this.backupDir, file);
        try {
          await fs.unlink(orphanPath);
          logger.warn(`Arquivo órfão removido: ${orphanPath}`);
        } catch (error) {
          logger.error('Erro ao remover arquivo órfão', { file, error: error.message });
        }
      }
    } catch (error) {
      logger.error('Erro ao limpar backups antigos', { tenantId, error: error.message });
    }
  }

  /**
   * Executa cleanOldBackups para todos os tenants cujos backups existem na pasta.
   * Útil para chamar na inicialização do servidor ou via cron separado.
   */
  async cleanAllTenants(tenantIds = []) {
    for (const tenantId of tenantIds) {
      await this.cleanOldBackups(tenantId);
    }
  }
}

export default new BackupService();
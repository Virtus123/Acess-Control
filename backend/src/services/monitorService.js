import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import dbManager from '../config/database.js';
import emailService from './emailService.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HISTORY_FILE = join(process.cwd(), 'database', 'monitoring_history.json');

class MonitorService {
  constructor() {
    this.historyLimitSteps = 168; // 7 dias * 24 horas (se for de hora em hora) ou apenas 7 se for diário.
    // Vamos usar 7 dias de histórico diário como solicitado ("durar uma semana no máximo").
  }

  async getDbStats() {
    const stats = [];
    const tenantsPath = dbManager.basePath;
    
    // 1. Bancos Globais
    const globalDbs = [
      { id: 'global', path: join(process.cwd(), 'database', 'global_notifications.db'), name: 'Global Notifications' },
      { id: 'security', path: join(process.cwd(), 'database', 'security.db'), name: 'Security & Auth' }
    ];

    for (const dbInfo of globalDbs) {
      try {
        const fileStat = await fs.stat(dbInfo.path);
        stats.push({ id: dbInfo.id, name: dbInfo.name, sizeBytes: fileStat.size });
      } catch (e) {
        logger.warn(`[Monitor] Erro ao medir DB ${dbInfo.id}: ${e.message}`);
      }
    }

    // 2. Bancos de Tenants
    try {
      const files = await fs.readdir(tenantsPath);
      const tenantFiles = files.filter(f => f.startsWith('tenant_') && f.endsWith('.db'));
      
      for (const file of tenantFiles) {
        const filePath = join(tenantsPath, file);
        const tenantId = file.replace('tenant_', '').replace('.db', '');
        try {
          const fileStat = await fs.stat(filePath);
          stats.push({ id: tenantId, name: `Tenant ${tenantId}`, sizeBytes: fileStat.size, isTenant: true });
        } catch (e) {
            // Ignorar erros individuais
        }
      }
    } catch (e) {
      logger.error('[Monitor] Erro ao listar diretório de tenants:', e.message);
    }

    return stats;
  }

  async getPhotoStats() {
    const photosDir = join(process.cwd(), 'public', 'uploads', 'photos');
    const statsByDay = {};
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    try {
      const files = await fs.readdir(photosDir);
      for (const file of files) {
        const filePath = join(photosDir, file);
        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat.isFile()) {
            const dateStr = fileStat.birthtime.toISOString().split('T')[0];
            if (new Date(fileStat.birthtime) >= oneWeekAgo) {
              statsByDay[dateStr] = (statsByDay[dateStr] || 0) + 1;
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      logger.warn(`[Monitor] Erro ao ler pasta de fotos: ${e.message}`);
    }

    return Object.entries(statsByDay)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async getServiceStatus() {
    const status = {
      database: { 
        status: 'ok', 
        message: 'Conectado',
        activeConnections: dbManager.connections ? dbManager.connections.size : 0
      },
      email: { 
        status: emailService.initialized ? 'ok' : 'error',
        message: emailService.initialized ? 'SMTP Conectado' : 'SMTP Falhou / Não configurado',
        queueSize: emailService.queue ? emailService.queue.length : 0
      },
      system: {
        status: 'ok',
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().rss
      }
    };
    return status;
  }

  async collectFullStats() {
    const [dbStats, photoStats, services] = await Promise.all([
      this.getDbStats(),
      this.getPhotoStats(),
      this.getServiceStatus()
    ]);

    return {
      timestamp: new Date().toISOString(),
      db: {
        totalSize: dbStats.reduce((acc, curr) => acc + curr.sizeBytes, 0),
        tenantsCount: dbStats.filter(s => s.isTenant).length,
        details: dbStats
      },
      photos: {
        totalLastWeek: photoStats.reduce((acc, curr) => acc + curr.count, 0),
        history: photoStats
      },
      services
    };
  }

  async persistDailyLog() {
    try {
      const stats = await this.collectFullStats();
      let history = [];

      try {
        const content = await fs.readFile(HISTORY_FILE, 'utf-8');
        history = JSON.parse(content);
      } catch (e) {
        // Arquivo não existe ou inválido
      }

      // Adicionar novo log
      history.unshift(stats);

      // Manter apenas 7 dias (limite de uma semana)
      // Se coletarmos 1x por dia, são 7 entradas.
      // Se for por hora, seriam 168. O usuário pediu "uma semana no máximo".
      // Vamos assumir rotina diária no cron, mas se rodar mais vezes, limpamos por data.
      
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      
      history = history.filter(item => new Date(item.timestamp) > oneWeekAgo);

      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
      logger.info('[Monitor] Log de monitoramento persistido com sucesso.');
      return true;
    } catch (error) {
      logger.error(`[Monitor] Erro ao persistir log: ${error.message}`);
      return false;
    }
  }

  async getHistory() {
    try {
      const content = await fs.readFile(HISTORY_FILE, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      return [];
    }
  }

  async getTenantStats() {
    const masterDb = await dbManager.getConnection('acesscontrolmaster');
    let tenants = [];
    try {
      tenants = await masterDb.all('SELECT tenant_id, company_name, status FROM tenants ORDER BY tenant_id');
    } catch (e) {
      logger.warn('[Monitor] Erro ao listar tenants:', e.message);
      return [];
    }

    const stats = await Promise.all(tenants.map(async (t) => {
      const result = {
        tenant_id: t.tenant_id,
        company_name: t.company_name,
        status: t.status,
        db_size: 0,
        persons: 0,
        equipments: 0,
        last_access: null,
        face_queue_pending: 0,
        sync_queue_pending: 0,
      };

      try {
        const dbPath = join(dbManager.basePath, `tenant_${t.tenant_id}.db`);
        const stat = await fs.stat(dbPath);
        result.db_size = stat.size;
      } catch { /* DB não encontrado */ }

      try {
        const db = await dbManager.getConnection(t.tenant_id);
        const [persons, equipments, lastAccess, faceQ, syncQ] = await Promise.all([
          db.get('SELECT COUNT(*) as count FROM persons WHERE status = "active"').catch(() => null),
          db.get('SELECT COUNT(*) as count FROM equipments').catch(() => null),
          db.get('SELECT created_at FROM access_log ORDER BY created_at DESC LIMIT 1').catch(() => null),
          db.get('SELECT COUNT(*) as count FROM face_queue WHERE status IN ("pending","processing")').catch(() => null),
          db.get('SELECT COUNT(*) as count FROM equip_sync_queue WHERE status IN ("pending","syncing")').catch(() => null),
        ]);
        result.persons = persons?.count || 0;
        result.equipments = equipments?.count || 0;
        result.last_access = lastAccess?.created_at || null;
        result.face_queue_pending = faceQ?.count || 0;
        result.sync_queue_pending = syncQ?.count || 0;
      } catch { /* tenant sem dados ainda */ }

      return result;
    }));

    return stats;
  }

  async getRecentLogs(limit = 60) {
    const logFile = join(process.cwd(), 'logs', 'combined.log');
    try {
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines
        .slice(-300)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .filter(l => ['error', 'warn'].includes(l.level))
        .reverse()
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  getSystemInfo() {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      uptime: process.uptime(),
      node_version: process.version,
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      os: {
        total_mb: Math.round(totalMem / 1024 / 1024),
        free_mb: Math.round(freeMem / 1024 / 1024),
        used_pct: Math.round(((totalMem - freeMem) / totalMem) * 100),
        platform: os.platform(),
        load_avg: os.loadavg(),
      },
    };
  }
}

export default new MonitorService();

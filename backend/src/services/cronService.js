import cron from 'cron';
import backupService from './backupService.js';
import dbManager from '../config/database.js';
import monitorService from './monitorService.js';
import logger from '../config/logger.js';
import fs from 'fs/promises';
import { join } from 'path';

async function getTenantIds() {
  try {
    const tenantsPath = process.env.DATABASE_STORAGE || join(process.cwd(), 'database', 'tenants');
    const files = await fs.readdir(tenantsPath);
    return files
      .filter(f => f.startsWith('tenant_') && f.endsWith('.db'))
      .map(f => f.replace('tenant_', '').replace('.db', ''));
  } catch (error) {
    logger.error('Erro ao listar tenants para backup', { error: error.message });
    return [];
  }
}

async function runDailyBackups() {
  try {
    logger.info('Iniciando backups automáticos diários');
    const tenantIds = await getTenantIds();

    for (const tenantId of tenantIds) {
      try {
        await backupService.createAutomaticBackup(tenantId);
        logger.info(`Backup automático criado para tenant: ${tenantId}`);
      } catch (error) {
        logger.error(`Erro ao criar backup para tenant ${tenantId}`, { error: error.message });
      }
    }

    logger.info('Backups automáticos concluídos');
  } catch (error) {
    logger.error('Erro ao executar backups automáticos', { error: error.message });
  }
}

// ============================================
// Função para inativar visitantes ao trocar o dia
// ============================================
async function runDailyVisitorCleanup() {
  // Validação de segurança: verificar se é realmente meia-noite em SP.
  // Isso resolve casos onde o TZ do processo não está configurado corretamente
  // e o cron dispara com base em UTC (3 horas antes do horário de Brasília).
  const nowSP = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
  );
  const hourSP = nowSP.getHours();

  // Aceita execução apenas entre 23:55 e 00:59 (horário de Brasília)
  const isValidHour = hourSP === 0 || hourSP === 23;
  if (!isValidHour) {
    logger.warn(
      `Limpeza de visitantes disparada fora do horário esperado (${hourSP}h BRT). Execução cancelada.`
    );
    return;
  }

  try {
    logger.info('Iniciando limpeza automática de visitantes');
    const tenantIds = await getTenantIds();

    for (const tenantId of tenantIds) {
      try {
        const db = dbManager.getTenantDb(tenantId);
        if (!db) continue;

        // 1. Inativar visitantes (se habilitado)
        const config = await db.get(
          "SELECT config_value FROM system_config WHERE config_key = 'module_inativar_visitantes_dia'"
        );

        const isEnabled = config && config.config_value === 'true';
        if (isEnabled) {
          logger.info(`Inativando visitantes expirados para tenant: ${tenantId}`);
          const nowIso = new Date().toISOString();
          const expiredVisitors = await db.all(
            `SELECT * FROM visitors
             WHERE status = 'on_premises'
               AND (
                 period_end IS NULL
                 OR period_end = ''
                 OR period_end < ?
               )`,
            [nowIso]
          );

          for (const visitor of expiredVisitors) {
            await db.run(
              "UPDATE visitors SET status = 'inactive', updated_at = datetime('now') WHERE id = ?",
              [visitor.id]
            );

            await db.run(
              `INSERT INTO access_tasks
               (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
               VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
              [tenantId, visitor.id, `Exclusão automática de visitante: ${visitor.name || visitor.id}`]
            );

            if (visitor.person_id) {
              await db.run(
                `INSERT INTO access_tasks
                 (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
                 VALUES (?, 'delete_person', 'person', ?, 'pending', datetime('now'), ?, 'all')`,
                [tenantId, visitor.person_id, 'Exclusão automática de pessoa vinculada ao visitante']
              );
            }
          }
        }

        // 2. Resetar contadores (se habilitado)
        const resetConfig = await db.get(
          "SELECT config_value FROM system_config WHERE config_key = 'reset_estatisticas_diario'"
        );
        
        if (resetConfig && resetConfig.config_value === 'true') {
          logger.info(`Resetando estatísticas diárias para tenant: ${tenantId}`);
          
          await db.run("UPDATE system_config SET config_value = '0' WHERE config_key = 'counter_pessoas_local'");
          await db.run("UPDATE system_config SET config_value = '0' WHERE config_key = 'counter_visitantes_local'");
          await db.run("UPDATE system_config SET config_value = '0' WHERE config_key = 'counter_veiculos_local'").catch(() => {});
          
          // Resetar contadores por equipamento
          await db.run("UPDATE equipments SET counter_veiculos_local = 0 WHERE controla_estacionamento = 1").catch(() => {});
        }

        logger.info(`Limpeza automática concluída para tenant: ${tenantId}`);
      } catch (error) {
        logger.error(`Erro ao executar limpeza automática para tenant ${tenantId}`, { error: error.message });
      }
    }

    logger.info('Limpeza automática de visitantes concluída');
  } catch (error) {
    logger.error('Erro ao executar limpeza automática de visitantes', { error: error.message });
  }
}

// ============================================
// Auditoria noturna: verifica quem está em cada equipamento e limpa extras
// ============================================
async function runDailyEquipmentAudit() {
  try {
    logger.info('[AUDIT-CRON] Iniciando auditoria noturna de equipamentos');
    const tenantIds = await getTenantIds();

    for (const tenantId of tenantIds) {
      try {
        const db = dbManager.getTenantDb(tenantId);
        if (!db) continue;

        const equipments = await db.all(
          "SELECT id, validador, name FROM equipments WHERE active = 1 AND status = 'active' AND validador IS NOT NULL"
        );

        for (const equip of equipments) {
          // Não criar se já existe uma tarefa pendente para este equipamento
          const existing = await db.get(
            "SELECT id FROM access_tasks WHERE task_type = 'audit_equipment' AND equip_validator = ? AND resolved = 0 LIMIT 1",
            [equip.validador]
          );
          if (existing) {
            logger.info(`[AUDIT-CRON] Tarefa pendente já existe para ${equip.name} — ignorando`);
            continue;
          }

          await db.run(
            `INSERT INTO access_tasks (tenant_id, task_type, equip_validator, status, resolved, created_at, description)
             VALUES (?, 'audit_equipment', ?, 'pending', 0, datetime('now'), ?)`,
            [tenantId, equip.validador, `Auditoria noturna: ${equip.name}`]
          );
          logger.info(`[AUDIT-CRON] Tarefa criada para ${equip.name} (${equip.validador})`);
        }
      } catch (error) {
        logger.error(`[AUDIT-CRON] Erro para tenant ${tenantId}: ${error.message}`);
      }
    }

    logger.info('[AUDIT-CRON] Auditoria noturna agendada com sucesso');
  } catch (error) {
    logger.error('[AUDIT-CRON] Erro geral:', { error: error.message });
  }
}

export function setupCronJobs() {
  if (!process.env.TZ) {
    process.env.TZ = 'America/Sao_Paulo';
    logger.info('TZ definido como America/Sao_Paulo pelo cronService');
  }

  const backupSchedule = process.env.BACKUP_SCHEDULE || '0 2 * * *';
  
  const backupJob = new cron.CronJob(
    backupSchedule,
    runDailyBackups,
    null,
    true,
    'America/Sao_Paulo'
  );

  const visitorCleanupJob = new cron.CronJob(
    '0 0 * * *',
    runDailyVisitorCleanup,
    null,
    true,
    'America/Sao_Paulo'
  );

  const monitorJob = new cron.CronJob(
    '0 0 * * *',
    async () => {
      logger.info('Iniciando persistência diária de logs de monitoramento...');
      await monitorService.persistDailyLog();
    },
    null,
    true,
    'America/Sao_Paulo'
  );

  const equipmentAuditJob = new cron.CronJob(
    '0 0 * * *',
    runDailyEquipmentAudit,
    null,
    true,
    'America/Sao_Paulo'
  );

  logger.info(`Cron jobs configurados. Backup agendado: ${backupSchedule}`);
  logger.info('Job de limpeza de visitantes agendado: 0 0 * * * (00:00 BRT)');
  logger.info('Job de monitoramento agendado: 0 0 * * * (00:00 BRT)');
  logger.info('Job de auditoria de equipamentos agendado: 0 0 * * * (00:00 BRT)');

  return {
    backupJob,
    visitorCleanupJob,
    monitorJob,
    equipmentAuditJob
  };
}

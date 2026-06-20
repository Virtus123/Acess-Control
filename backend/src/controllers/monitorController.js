import monitorService from '../services/monitorService.js';
import logger from '../config/logger.js';

export const getStats = async (req, res) => {
  try {
    const stats = await monitorService.collectFullStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error(`[MonitorController] Erro ao obter estatísticas: ${error.message}`);
    res.status(500).json({ success: false, message: 'Erro ao obter estatísticas de monitoramento' });
  }
};

export const getHistory = async (req, res) => {
  try {
    const history = await monitorService.getHistory();
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error(`[MonitorController] Erro ao obter histórico: ${error.message}`);
    res.status(500).json({ success: false, message: 'Erro ao obter histórico de monitoramento' });
  }
};

export const forceSaveLog = async (req, res) => {
  try {
    await monitorService.persistDailyLog();
    res.json({ success: true, message: 'Log de monitoramento persistido com sucesso.' });
  } catch (error) {
    logger.error(`[MonitorController] Erro ao forçar persistência: ${error.message}`);
    res.status(500).json({ success: false, message: 'Erro ao persistir log' });
  }
};

export const getTenantStats = async (req, res) => {
  try {
    const stats = await monitorService.getTenantStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error(`[MonitorController] Erro ao obter stats de tenants: ${error.message}`);
    res.status(500).json({ success: false, message: 'Erro ao obter stats de tenants' });
  }
};

export const getRecentLogs = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 60, 200);
    const logs = await monitorService.getRecentLogs(limit);
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error(`[MonitorController] Erro ao obter logs: ${error.message}`);
    res.status(500).json({ success: false, message: 'Erro ao obter logs' });
  }
};

export const getSystemInfo = async (req, res) => {
  try {
    const info = monitorService.getSystemInfo();
    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao obter informações do sistema' });
  }
};

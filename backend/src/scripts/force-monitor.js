import 'dotenv/config';
import monitorService from '../services/monitorService.js';
import logger from '../config/logger.js';

async function force() {
  console.log('--- Iniciando Coleta Forçada de Monitoramento ---');
  try {
    const success = await monitorService.persistDailyLog();
    if (success) {
      console.log('✅ Monitoramento persistido com sucesso em monitoring_history.json');
      process.exit(0);
    } else {
      console.error('❌ Falha ao persistir monitoramento.');
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Erro crítico: ${error.message}`);
    process.exit(1);
  }
}

force();

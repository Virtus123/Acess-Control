import dbManager from '../config/database.js';
import { runMigrations } from '../database/migrate.js';
import logger from '../config/logger.js';

let initialized = false;

export async function initializeTenantManager() {
  if (initialized) return;
  
  await dbManager.init();
  initialized = true;
  logger.info('Tenant manager initialized');
}

export async function getTenantDatabase(tenantId) {
  if (!tenantId) {
    throw new Error('Tenant ID é obrigatório');
  }

  const exists = await dbManager.tenantExists(tenantId);
  
  if (!exists) {
    logger.error(`Tentativa de acesso a tenant inexistente: ${tenantId}`);
    const error = new Error(`Empresa '${tenantId}' não encontrada. Verifique o ID digitado.`);
    error.status = 404;
    throw error;
  }

  // As migrações são executadas na criação do tenant ou manualmente via script de manutenção.
  // Executá-las em cada request causa conflitos de transação no SQLite sob carga.

  return await dbManager.getConnection(tenantId);
}

export function tenantMiddleware(req, res, next) {
  // Rotas que resolvem o tenant internamente (não precisam do header)
  if (
    req.path.startsWith('/contato') ||
    req.path.startsWith('/comunicador') ||
    req.path === '/auth/login' ||
    req.path === '/auth/login-mobile'
  ) {
    return next();
  }

  let tenantId = req.headers['x-tenant-id'] || req.query.tenantId || req.body.tenantId;
  
  // Robustness: Handle multiple headers joined by commas (e.g. "omini, omini")
  if (typeof tenantId === 'string' && tenantId.includes(',')) {
    tenantId = tenantId.split(',')[0].trim();
  }
  
  if (!tenantId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Tenant ID é obrigatório. Envie via header X-Tenant-ID' 
    });
  }

  req.tenantId = tenantId;
  
  getTenantDatabase(tenantId)
    .then(db => {
      req.db = db;
      next();
    })
    .catch(error => {
      logger.error('Erro ao obter conexão do tenant', { tenantId, error: error.message });
      
      const status = error.status || 500;
      const message = status === 404 ? 'UNIDADE NÃO LOCALIZADA' : 'Erro ao conectar com o banco de dados do tenant';
      
      res.status(status).json({ 
        success: false, 
        message: message
      });
    });
}




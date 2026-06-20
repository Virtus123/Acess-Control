import expressListEndpoints from 'express-list-endpoints';
import app from '../server.js';
import logger from '../config/logger.js';

/**
 * Script de Auditoria de Rotas
 * Lista todas as rotas e verifica quais não possuem middleware de autenticação
 * (Para ser executado manualmente ou via teste)
 */
export function auditRoutes() {
  const endpoints = expressListEndpoints(app);
  const publicPaths = [
    '/api/health',
    '/api/auth/login',
    '/api/auth/login-mobile',
    '/api/comunicador',
    '/api/autorizacao',
    '/api-docs'
  ];

  logger.info('--- AUDITORIA DE ROTAS SEGURAS ---');
  
  endpoints.forEach(route => {
    const isPublic = publicPaths.some(p => route.path.startsWith(p));
    const hasAuth = route.middlewares.some(m => m.includes('authenticate') || m.includes('require'));
    
    if (!isPublic && !hasAuth) {
      logger.warn(`[RISCO] Rota possivelmente desprotegida: ${route.methods.join(',')} ${route.path}`);
    } else {
      logger.debug(`[OK] Rota verificada: ${route.path}`);
    }
  });

  logger.info('--- FIM DA AUDITORIA ---');
  return endpoints;
}

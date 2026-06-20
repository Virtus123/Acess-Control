import logger from '../config/logger.js';

export function auditLog(action, entityType = null, entityId = null) {
  return async (req, res, next) => {
    const originalSend = res.json.bind(res);
    
    res.json = function(data) {
      const shouldLog = res.statusCode >= 200 && res.statusCode < 300;
      
      if (shouldLog && req.user) {
        const auditData = {
          user_id: req.user.id,
          action,
          entity_type: entityType || req.body.entity_type,
          entity_id: entityId || req.params.id || req.body.entity_id,
          details: JSON.stringify(req.body),
          ip_address: req.ip || req.connection.remoteAddress,
          user_agent: req.headers['user-agent'],
          created_at: new Date().toISOString()
        };

        req.db.run(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, user_agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            auditData.user_id,
            auditData.action,
            auditData.entity_type,
            auditData.entity_id,
            auditData.details,
            auditData.ip_address,
            auditData.user_agent,
            auditData.created_at
          ]
        ).catch(error => {
          logger.error('Erro ao registrar log de auditoria', { error: error.message });
        });

        logger.info('Auditoria registrada', {
          action,
          user_id: req.user.id,
          entity_type: auditData.entity_type,
          entity_id: auditData.entity_id
        });
      }

      return originalSend(data);
    };

    next();
  };
}




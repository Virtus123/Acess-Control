import logger from '../config/logger.js';

export function errorHandler(err, req, res, next) {
  // Não exibir log para erros específicos que não precisam ser mostrados
  const ignoredErrors = [
    'no such column: tenant_id',
    'no such column: direction_entrada',
    'no such column: direction_saida'
  ];
  
  const shouldIgnore = ignoredErrors.some(ignored => 
    err.message && err.message.toLowerCase().includes(ignored.toLowerCase())
  );
  
  if (!shouldIgnore) {
    logger.error('Erro na requisição', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      ip: req.ip
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Erro de validação',
      errors: err.errors
    });
  }

  if (err.name === 'UnauthorizedError' || err.message.includes('Token')) {
    return res.status(401).json({
      success: false,
      message: 'Não autorizado'
    });
  }

  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Erro interno do servidor' 
    : err.message;

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

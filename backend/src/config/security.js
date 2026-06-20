import rateLimit from 'express-rate-limit';

// Disable rate limiting in development
const isProduction = process.env.NODE_ENV === 'production';

export const rateLimiter = isProduction ? rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000,
  message: { error: 'Muitas requisições. Tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false
}) : (req, res, next) => next();

export const authLimiter = isProduction ? rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Limite mais restrito para login/auth
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
}) : (req, res, next) => next();




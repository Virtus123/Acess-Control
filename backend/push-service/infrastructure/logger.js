import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = join(__dirname, '..', '..', 'logs');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'mam-push' },
  transports: [
    new winston.transports.File({
      filename: join(logDir, 'push.log'),
      maxsize: 50_000_000,
      maxFiles: 10,
      tailable: true,
    }),
    new winston.transports.File({
      filename: join(logDir, 'push-error.log'),
      level: 'error',
      maxsize: 50_000_000,
      maxFiles: 10,
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

export default logger;

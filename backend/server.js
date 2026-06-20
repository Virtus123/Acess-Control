import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import { createServer as createServerHttps } from 'https';
import { readFileSync, existsSync } from 'fs';
import logger from './src/config/logger.js';
import dbManager from './src/config/database.js';
import securityDb from './src/config/securityDb.js';
import globalDb from './src/config/globalDatabase.js';
import { setupCronJobs } from './src/services/cronService.js';
import { initializeTenantManager } from './src/middleware/tenantManager.js';
import emailService from './src/services/emailService.js';
import routes from './src/routes/index.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './src/config/swagger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Segurança: Não expor que o servidor é Express
app.disable('x-powered-by');

// CSP: Content Security Policy (Modo Report-Only inicial para evitar quebras)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy-Report-Only',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: *; connect-src 'self' *;"
  );
  next();
});

// Criar servidor com suporte a HTTPS em produção
let server;
let protocol = 'HTTP';

// Verificar se temos certificados SSL disponíveis
const certPath = process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/mamcontrol.com.br/fullchain.pem';
const keyPath = process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/mamcontrol.com.br/privkey.pem';

if (process.env.USE_HTTPS === 'true' && existsSync(certPath) && existsSync(keyPath)) {
  try {
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    server = createServerHttps({ cert, key }, app);
    protocol = 'HTTPS';
    console.log('✅ SSL/TLS habilitado');
  } catch (error) {
    console.warn('⚠️ Não foi possível carregar certificados SSL, usando HTTP:', error.message);
    server = createServer(app);
  }
} else {
  server = createServer(app);
}

const PORT = process.env.PORT || 3000;

// CSP estrita só na VPS (NODE_ENV=production sem SERVE_FRONTEND).
// Em modo local (SERVE_FRONTEND=true) ou dev, CSP fica desabilitada porque
// o frontend carrega Font Awesome, Chart.js e outros recursos de CDNs externos.
const isVpsProduction = process.env.NODE_ENV === 'production' && process.env.SERVE_FRONTEND !== 'true';

if (isVpsProduction) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:", "blob:", "https://validator.swagger.io"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true
    }
  }));
} else {
  // Desenvolvimento ou instalação local: sem CSP restritiva
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));
}

app.use(compression());

const whitelist = [
  'https://mamcontrol.com.br',
  'https://www.mamcontrol.com.br',
  process.env.FRONTEND_URL || 'https://mamcontrol.com.br'
];

app.use(cors({
  origin: (origin, callback) => {
    // Sem origin: requisição server-side ou mobile — permite
    if (!origin) return callback(null, true);

    // Modo local: permite localhost em qualquer porta
    if (process.env.SERVE_FRONTEND === 'true') {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
    }

    if (whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
  preflightContinue: false
}));

app.use(express.json({ limit: '2mb' })); // Limite de 2MB conforme plano Nginx
app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 10000 }));
app.use(cookieParser());
app.set('trust proxy', 1); // Confiar no primeiro proxy (Nginx)

// Increase timeout for large file uploads (10 minutes)
app.use((req, res, next) => {
  res.setTimeout(600000, () => {
    res.status(503).json({ error: 'Request timeout' });
  });
  next();
});

// Servir arquivos estáticos do backend (uploads, backups, etc)
app.use(express.static(join(__dirname, 'public')));

// Em produção com Nginx, o frontend é servido pelo Nginx.
// Em desenvolvimento ou instalação local (SERVE_FRONTEND=true), o backend serve o frontend.
const serveLocalFrontend = process.env.NODE_ENV !== 'production' || process.env.SERVE_FRONTEND === 'true';
if (serveLocalFrontend) {
  app.use(express.static(join(__dirname, '..', 'frontend')));
}

// /foto/:token → página pública de auto-cadastro de foto.
// Funciona em DEV (backend serve) e PROD (nginx config equivalente, ver
// PLANO_PUBLIC_PHOTO.md). JS da página lê o token de location.pathname.
app.get('/foto/:token', (req, res) => {
  res.sendFile(join(__dirname, '..', 'frontend', 'pages', 'foto', 'index.html'));
});

app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// Rotas principais
/**
 * @swagger
 * /:
 *   get:
 *     summary: Informações gerais da API
 *     tags: [Geral]
 *     responses:
 *       200:
 *         description: Bem-vindo à API MAM Control
 */
app.get('/api', (req, res) => {
  res.json({
    message: 'MAM Control API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      persons: '/api/persons',
      visitors: '/api/visitors',
      groups: '/api/groups',
      companies: '/api/companies',
      exports: '/api/exports',
      reports: '/api/reports',
      config: '/api/config'
    }
  });
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check de saúde do sistema
 *     tags: [Geral]
 *     responses:
 *       200:
 *         description: Sistema operando normalmente
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Swagger Documentation
// Rota JSON do spec (importável por Postman, Insomnia, etc.)
app.get('/api-docs/v1/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Swagger UI versionado
app.use('/api-docs/v1', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: "MAM Control API v1 Documentation",
  swaggerOptions: {
    persistAuthorization: true,
    url: '/api-docs/v1/swagger.json',
  }
}));

// Redirecionar /api-docs -> /api-docs/v1 por conveniência
app.get('/api-docs', (req, res) => res.redirect('/api-docs/v1'));

// Rotas da API
app.use('/api', routes);

// Fallback para rotas do frontend (desenvolvimento ou instalação local)
if (serveLocalFrontend) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({
        success: false,
        message: 'Rota de API não encontrada',
        path: req.path
      });
    }

    if (req.path.startsWith('/uploads')) {
      return res.status(404).json({
        success: false,
        message: 'Arquivo de imagem ou recurso não encontrado'
      });
    }

    // Try to serve .html file for clean URLs (e.g., /dashboard -> /dashboard.html)
    const cleanPath = req.path === '/' ? '/index.html' : req.path + '.html';
    const filePath = join(__dirname, '..', 'frontend', cleanPath);

    if (existsSync(filePath)) {
      return res.sendFile(filePath);
    }

    // Also try the original path (for direct .html access)
    const originalFilePath = req.path === '/'
      ? join(__dirname, '..', 'frontend', 'index.html')
      : join(__dirname, '..', 'frontend', req.path);

    if (existsSync(originalFilePath)) {
      return res.sendFile(originalFilePath);
    }

    // Fallback to index.html for SPA routing
    res.sendFile(join(__dirname, '..', 'frontend', 'index.html'));
  });
}

app.use(errorHandler);

async function startServer() {
  try {
    console.log('🔄 Inicializando serviço de email...');
    await emailService.init();
    console.log('✅ Serviço de email inicializado');

    console.log('🔄 Inicializando tenant manager...');
    await initializeTenantManager();
    console.log('✅ Tenant manager inicializado');

    console.log('🔄 Inicializando bancos de dados...');
    await dbManager.init();
    await securityDb.init();
    await globalDb.init();
    console.log('✅ Bancos de dados inicializados');

    console.log('🔄 Configurando cron jobs...');
    setupCronJobs();
    console.log('✅ Cron jobs configurados');

    console.log(`🚀 Iniciando servidor na porta ${PORT}...`);
    server.listen(PORT, '0.0.0.0', () => { // Bind em Localhost para evitar bypass
      console.log(`\n✅ ====================================`);
      console.log(`✅ MAM Control API`);
      console.log(`✅ Porta: ${PORT}`);
      console.log(`✅ Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✅ URL: http://<seu-ip>:${PORT}/api`);
      console.log(`✅ Docs:       http://<seu-ip>:${PORT}/api-docs/v1`);
      console.log(`✅ Swagger JSON: http://<seu-ip>:${PORT}/api-docs/v1/swagger.json`);
      console.log(`✅ ====================================\n`);

      logger.info(`Server running on port ${PORT}`, {
        env: process.env.NODE_ENV || 'development',
        port: PORT
      });
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Erro: Porta ${PORT} já está em uso!`);
        console.error(`   Tente parar o processo que está usando a porta ${PORT} ou mude a porta no arquivo .env`);
      } else {
        console.error('❌ Erro ao iniciar servidor:', error);
      }
      logger.error('Server error', { error: error.message, stack: error.stack });
      process.exit(1);
    });
  } catch (error) {
    console.error('❌ Erro ao inicializar servidor:', error.message);
    console.error('Stack:', error.stack);
    logger.error('Failed to initialize server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startServer();

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message });
  process.exit(1);
});

export default app;


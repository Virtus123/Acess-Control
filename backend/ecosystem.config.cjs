module.exports = {
  apps: [
    {
      name: 'acess-control-backend',
      script: './server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        BASE_URL: 'https://example.com',
        FRONTEND_URL: 'https://example.com'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000
    },
    {
      name: 'nexis-push',
      script: './push-service/server.js',
      exec_mode: 'fork',           // NÃO cluster (waiters in-memory por processo)
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PUSH_PORT: 3001,
        PUSH_HOST: '127.0.0.1',    // localmente: 0.0.0.0 para equipamento na LAN
        PUSH_LONG_POLL_MS: 25000,
        // Mesmo caminho do dbManager do backend antigo (mesmos SQLites).
        // Vazio = usa default relativo a push-service/infrastructure/tenantDb.js
        // (../../database/tenants), que coincide com o storage do backend.
        // DATABASE_STORAGE: '',
        LOG_LEVEL: 'info',
        // Onde o helper pushOutbox.js (no backend antigo) acha o Push.
        PUSH_SERVICE_URL: 'http://127.0.0.1:3001',
      },
      error_file: './logs/push-error.log',
      out_file: './logs/push-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000
    }
  ]
};

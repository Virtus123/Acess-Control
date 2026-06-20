import express from 'express';
import {
  processarAcesso,
  confirmarAcesso,
  healthCheck,
  listarLogs,
  invalidateCacheEndpoint,
  debugCacheEndpoint
} from '../controllers/autorizacaoController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// ============================================
// ROTAS PÚBLICAS DO COMUNICADOR (sem autenticação)
// ============================================

// Processar acesso do comunicador
router.post('/access', processarAcesso);

// Confirmar acesso (standalone: equipamento decidiu, comunicador registra o log)
router.post('/access/confirm', confirmarAcesso);

// Health check
router.get('/status', healthCheck);

// Debug - invalidar cache
router.post('/invalidate-cache', invalidateCacheEndpoint);

// Debug - info do cache
router.get('/debug-cache', debugCacheEndpoint);

// ============================================
// ROTAS PROTEGIDAS (para o frontend - requer autenticação)
// ============================================

// Listar logs de acesso
router.get('/logs', authenticate, listarLogs);

export default router;

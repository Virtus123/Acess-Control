import express from 'express';
import { 
  addToQueue, 
  listPending, 
  markProcessed, 
  markError, 
  listHistory,
  comunicadorGetQueue,
  comunicadorMarkProcessed,
  comunicadorMarkError,
  comunicadorEquipmentStatus
} from '../controllers/faceQueueController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// ============================================
// ROTAS PÚBLICAS DO COMUNICADOR (sem autenticação)
// ============================================

// Buscar fila pendente
router.get('/comunicador/queue', comunicadorGetQueue);

// Marcar como processado (enviado ao equipamento)
router.post('/comunicador/process', comunicadorMarkProcessed);

// Marcar como erro
router.post('/comunicador/error', comunicadorMarkError);

// Enviar status do equipamento (online/offline)
router.post('/comunicador/equipment/status', comunicadorEquipmentStatus);

// ============================================
// ROTAS PROTEGIDAS (para o frontend - requer autenticação)
// ============================================

// Adicionar manualmente à fila
router.post('/queue', authenticate, addToQueue);

// Listar fotos pendentes
router.get('/queue/pending', authenticate, listPending);

// Marcar como processado
router.put('/queue/:id/process', authenticate, markProcessed);

// Marcar como erro
router.put('/queue/:id/error', authenticate, markError);

// Listar histórico
router.get('/queue/history', authenticate, listHistory);

export default router;

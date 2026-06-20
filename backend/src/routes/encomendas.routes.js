import { Router } from 'express';
import * as encomendaController from '../controllers/encomendaController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = Router();

// Rotas para o sistema web (autenticadas)
router.get('/', authenticate, requirePermission('encomendas'), encomendaController.list);
router.get('/stats', authenticate, requirePermission('encomendas'), encomendaController.stats);
router.get('/:id', authenticate, requirePermission('encomendas'), encomendaController.getById);
router.post('/', authenticate, requirePermission('encomendas'), encomendaController.create);
router.put('/:id', authenticate, requirePermission('encomendas'), encomendaController.update);
router.delete('/:id', authenticate, requirePermission('encomendas'), encomendaController.remove);
router.post('/:id/retirada', authenticate, requirePermission('encomendas'), encomendaController.registrarRetirada);

// Rotas para o app mobile (também autenticadas, mas com funcionalidades específicas)
router.get('/app/pendentes', authenticate, requirePermission('encomendas'), encomendaController.listPending);
router.post('/:id/app/entrega', authenticate, requirePermission('encomendas'), encomendaController.deliverViaApp);

export default router;

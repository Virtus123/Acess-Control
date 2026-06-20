import express from 'express';
import {
  getPriceTables,
  getPriceTable,
  createPriceTable,
  updatePriceTable,
  deletePriceTable,
  calculatePrice
} from '../controllers/priceController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticate);

// Rotas públicas para calcular preço
router.post('/calculate', calculatePrice);

// Rotas admin para gerenciar tabelas de preços
router.get('/', requireRole('admin', 'admin_master'), getPriceTables);
router.get('/:id', requireRole('admin', 'admin_master'), getPriceTable);
router.post('/', requireRole('admin', 'admin_master'), createPriceTable);
router.put('/:id', requireRole('admin', 'admin_master'), updatePriceTable);
router.patch('/:id', requireRole('admin', 'admin_master'), updatePriceTable);
router.delete('/:id', requireRole('admin', 'admin_master'), deletePriceTable);

export default router;

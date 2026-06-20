import express from 'express';
import { generateBillingReport } from '../controllers/billingController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Apenas Admin Master pode gerar relatórios de faturamento
router.get('/report', authenticate, requireRole('admin'), generateBillingReport);

export default router;

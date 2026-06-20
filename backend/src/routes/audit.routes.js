import express from 'express';
import * as auditController from '../controllers/auditController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticate);

router.get('/', auditController.getLogs);
router.get('/:id', auditController.getLogById);

export default router;

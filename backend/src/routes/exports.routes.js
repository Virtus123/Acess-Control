import express from 'express';
import {
  createExport,
  listExports,
  getExportStatus,
  downloadExport
} from '../controllers/exportController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = express.Router();

router.use(authenticate);

router.get('/', requirePermission('exports'), listExports);
router.post('/', requirePermission('exports'), createExport);
router.get('/:id', requirePermission('exports'), getExportStatus);
router.get('/:id/download', requirePermission('exports'), downloadExport);

export default router;




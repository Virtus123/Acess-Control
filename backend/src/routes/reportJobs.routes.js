import express from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import {
  createReportJob,
  listReportJobs,
  getReportJobStatus,
  downloadReportJob
} from '../controllers/reportJobController.js';

const router = express.Router();

router.use(authenticate);

router.post('/', requirePermission('reports'), createReportJob);
router.get('/', requirePermission('reports'), listReportJobs);
router.get('/:id', requirePermission('reports'), getReportJobStatus);
router.get('/:id/download', requirePermission('reports'), downloadReportJob);

export default router;

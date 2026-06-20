import express from 'express';
import syncController from '../controllers/syncController.js';

const router = express.Router();

// GET /api/comunicador/sync/check
router.get('/check', syncController.checkSyncTurn);

// GET /api/comunicador/sync/data  (requer sessão ativa na equip_sync_queue)
router.get('/data', syncController.getSyncData);

// GET /api/comunicador/sync/diff-data  (sem exigir sessão — usado pelo diff sync)
router.get('/diff-data', syncController.getDiffSyncData);

// POST /api/comunicador/sync/complete
router.post('/complete', syncController.completeSync);

// POST /api/comunicador/sync/clear
router.post('/clear', syncController.clearSyncQueue);

export default router;

import express from 'express';
import faceRemoteController from '../controllers/faceRemoteController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * Frontend routes (Authenticated)
 */
router.post('/task/:tenant_id', authenticate, faceRemoteController.createFaceTask);
router.get('/status/:tenant_id/:task_id', authenticate, faceRemoteController.getFaceTaskStatus);
router.delete('/task/:tenant_id/:task_id', authenticate, faceRemoteController.cancelFaceTask);

/**
 * Communicator routes (No user authentication required, but tenantId is needed)
 */
router.post('/receive/:tenant_id/:task_id', faceRemoteController.receiveFacePhoto);
router.post('/error/:tenant_id/:task_id', faceRemoteController.reportFaceError);

export default router;

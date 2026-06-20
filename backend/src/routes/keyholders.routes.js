import express from 'express';
import keyholderController from '../controllers/keyholderController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// CRUD operations
router.get('/', keyholderController.getAll.bind(keyholderController));
router.get('/:id', keyholderController.getById.bind(keyholderController));
router.post('/', keyholderController.create.bind(keyholderController));
router.put('/:id', keyholderController.update.bind(keyholderController));
router.delete('/:id', keyholderController.delete.bind(keyholderController));

export default router;

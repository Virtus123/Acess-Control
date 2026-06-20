import express from 'express';
import cafeteriaController from '../controllers/cafeteriaController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// CRUD operations
router.get('/', cafeteriaController.getAll.bind(cafeteriaController));
router.get('/:id', cafeteriaController.getById.bind(cafeteriaController));
router.post('/', cafeteriaController.create.bind(cafeteriaController));
router.put('/:id', cafeteriaController.update.bind(cafeteriaController));
router.delete('/:id', cafeteriaController.delete.bind(cafeteriaController));

export default router;

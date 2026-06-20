import express from 'express';
import holidayController from '../controllers/holidayController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// CRUD operations
router.get('/', holidayController.getAll.bind(holidayController));
router.get('/:id', holidayController.getById.bind(holidayController));
router.post('/', holidayController.create.bind(holidayController));
router.put('/:id', holidayController.update.bind(holidayController));
router.delete('/:id', holidayController.delete.bind(holidayController));

export default router;

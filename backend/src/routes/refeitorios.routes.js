import express from 'express';
import {
  list,
  getById,
  create,
  update,
  remove
} from '../controllers/refeitorioController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';


const router = express.Router();

router.use(authenticate);

router.get('/', requirePermission('refeitorios'), list);
router.get('/:id', requirePermission('refeitorios'), getById);
router.post('/', requirePermission('refeitorios'), create);
router.put('/:id', requirePermission('refeitorios'), update);
router.delete('/:id', requirePermission('refeitorios'), remove);

export default router;

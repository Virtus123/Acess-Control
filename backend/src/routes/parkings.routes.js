import express from 'express';
import {
  list,
  getById,
  create,
  update,
  remove,
  getSpots,
  createSpots,
  deleteSpot
} from '../controllers/parkingController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';


const router = express.Router();

router.use(authenticate);

router.get('/', requirePermission('parkings'), list);
router.get('/:id', requirePermission('parkings'), getById);
router.post('/', requirePermission('parkings'), create);
router.put('/:id', requirePermission('parkings'), update);
router.delete('/:id', requirePermission('parkings'), remove);

// Rotas de vagas (spots)
router.get('/:id/spots', requirePermission('parkings'), getSpots);
router.post('/:id/spots', requirePermission('parkings'), createSpots);
router.delete('/:id/spots/:spotId', requirePermission('parkings'), deleteSpot);

export default router;

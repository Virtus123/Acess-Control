import express from 'express';
import { 
  getAllProfiles, 
  getProfileById, 
  createProfile, 
  updateProfile, 
  deleteProfile,
  getAvailablePermissions
} from '../controllers/authorizationProfileController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Apply authenticate middleware to all routes
router.use(authenticate);

// CRUD operations for authorization profiles
router.get('/profiles', getAllProfiles);
router.get('/profiles/available', getAvailablePermissions);
router.get('/profiles/:id', getProfileById);
router.post('/profiles', createProfile);
router.put('/profiles/:id', updateProfile);
router.delete('/profiles/:id', deleteProfile);

export default router;

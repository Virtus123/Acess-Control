import express from 'express';
import { 
  getDashboardStats, 
  getWeeklyAccessData, 
  getRecentActivities 
} from '../controllers/dashboardController.js';

const router = express.Router();

// Rotas do Dashboard
// GET /api/dashboard/stats - Estatísticas gerais
router.get('/stats', getDashboardStats);

// GET /api/dashboard/weekly - Dados semanais para gráficos
router.get('/weekly', getWeeklyAccessData);

// GET /api/dashboard/activities - Atividades recentes
router.get('/activities', getRecentActivities);

export default router;

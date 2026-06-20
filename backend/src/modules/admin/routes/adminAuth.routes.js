import express from 'express';
import rateLimit from 'express-rate-limit';
import adminAuthController from '../controllers/adminAuthController.js';
import { getStats } from '../controllers/adminStatsController.js';
import { adminAuthMiddleware, requireRole } from '../middleware/adminAuthMiddleware.js';

const router = express.Router();

/**
 * Rate limit no login administrativo (Plano 2.1 - Fase 4)
 * Janela: 15 minutos | Máximo: 10 tentativas
 */
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { 
        success: false, 
        message: 'Muitas tentativas de login administrativo. Aguarde 15 minutos.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// POST /login - Nova Lógica de Autenticação Global (Público)
router.post('/login', adminLoginLimiter, adminAuthController.login);

/**
 * ROTAS PROTEGIDAS ADMINISTRATIVAS (AUTENTICAÇÃO ISOLADA)
 */
router.use(adminAuthMiddleware);

// GET /me - Check de token e perfil do admin logado
router.get('/me', adminAuthController.me);

// GET /stats - Estatísticas reais do Dashboard (Plano 2.1 Fase 5)
router.get('/stats', getStats);

// PATCH /profile - Atualizar e-mail e senha do perfil administrativo
router.patch('/profile', (req, res) => adminAuthController.updateProfile(req, res));

// POST /register - Criar novo administrador (Plano 2.1 Fase 3 - Apenas super_admin)
router.post('/register', requireRole('super_admin'), adminAuthController.registerAdmin);

export default router;

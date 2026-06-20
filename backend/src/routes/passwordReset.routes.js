import express from 'express';
import { solicitarResetCode, verificarCodigo, alterarSenha } from '../controllers/passwordResetController.js';
import { getTenantDatabase } from '../middleware/tenantManager.js';

const router = express.Router();

// Middleware para obter o banco de dados do tenant
async function tenantDbMiddleware(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] || req.body.tenantId || req.query.tenantId;
  
  if (!tenantId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Tenant ID é obrigatório' 
    });
  }

  try {
    const db = await getTenantDatabase(tenantId);
    req.db = db;
    req.tenantId = tenantId;
    next();
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao conectar com o banco de dados' 
    });
  }
}

// Rotas de recuperação de senha (precisam do tenant)
router.post('/esqueci-senha', tenantDbMiddleware, solicitarResetCode);
router.post('/verificar-codigo', tenantDbMiddleware, verificarCodigo);
router.post('/nova-senha', tenantDbMiddleware, alterarSenha);

export default router;

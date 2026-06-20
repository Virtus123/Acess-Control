import jwt from 'jsonwebtoken';
import logger from '../../../config/logger.js';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

/**
 * Middleware de Autenticação Administrativa (Plano 2.1)
 * Regra: Totalmente isolado do contexto de tenants.
 */
export const adminAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (!token) {
        logger.warn(`[AdminAudit] Tentativa de acesso sem token detectada de ${req.ip} | ${req.method} ${req.originalUrl}`);
        return res.status(401).json({ 
            success: false, 
            message: 'Acesso negado. Token administrativo não fornecido.' 
        });
    }

    try {
        const decoded = jwt.verify(token, ADMIN_JWT_SECRET);

        // Regra Crítica 2.1: Verificar tipo do token
        if (decoded.type !== 'admin') {
            logger.error(`[AdminAudit] Tentativa de bypass com token de tipo inválido (${decoded.type}) de ${req.ip}`);
            return res.status(403).json({ 
                success: false, 
                message: 'Acesso negado. Token incompatível.' 
            });
        }

        // Injetar dados no request para uso nas rotas e RBAC
        req.admin = {
            id: decoded.admin_id,
            role: decoded.role,
            email: decoded.email
        };

        // Compatibilidade Retroativa: Alguns controllers (ex: tenantController) 
        // esperam req.user.role e is_master.
        req.user = {
            ...req.admin,
            is_master: decoded.role === 'super_admin',
            tenant_id: process.env.SYSTEM_TENANT_ID || 'acesscontrolmaster' // Contexto master
        };

        // DEBUG: Imprimir payload de quem passou no middleware
        console.log(`[DEBUG TERMINAL] Request Autenticado no mPanel -> Role: ${req.admin.role} | Rota: ${req.method} ${req.originalUrl}`);
        logger.debug(`[AdminMiddleware] Request Autorizado -> Rota: ${req.originalUrl} | Email: ${req.admin.email} | Role: ${req.admin.role}`);

        next();
    } catch (error) {
        logger.error(`[AdminAudit] Token administrativo inválido ou expirado | Erro: ${error.message} | IP: ${req.ip}`);
        return res.status(401).json({ 
            success: false, 
            message: 'Token administrativo inválido ou expirado.' 
        });
    }
};

/**
 * Função helper para restringir acesso por Role (RBAC)
 */
export const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.admin) {
            return res.status(401).json({ success: false, message: 'Admin não autenticado.' });
        }

        if (!allowedRoles.includes(req.admin.role)) {
            console.error(`\n[DEBUG TERMINAL] ACESSO NEGADO (403) - Email: ${req.admin.email} tentou acessar ${req.method} ${req.originalUrl}`);
            console.error(`[DEBUG TERMINAL] -> O usuário tem role '${req.admin.role}', mas a rota exige: [${allowedRoles.join(', ')}]\n`);
            
            logger.warn(`[AdminAudit] ${req.admin.email} | ACESSO NEGADO | Permissão insuficiente (${req.admin.role}) para ${req.method} ${req.originalUrl}`);
            return res.status(403).json({ 
                success: false, 
                message: 'Permissão insuficiente para esta ação.' 
            });
        }

        next();
    };
};

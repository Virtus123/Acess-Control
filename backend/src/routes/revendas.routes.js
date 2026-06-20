import express from 'express';
import dbManager from '../config/database.js';
import { hashPassword } from '../utils/generators.js';
import { runMigrations } from '../database/migrate.js';
import logger from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Todas as rotas de revenda requerem autenticação
router.use(authenticate);

// Listar revendas - apenas admin master
router.get('/', requireRole('admin'), asyncHandler(async (req, res) => {
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        const revendas = await dbMaster.all('SELECT * FROM revendas ORDER BY created_at DESC');
        
        res.json({
            success: true,
            data: revendas
        });
    } catch (error) {
        logger.error('Erro ao listar revendas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar revendas'
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

// Criar revenda
router.post('/', asyncHandler(async (req, res) => {
    const {
        tenant_id,
        cnpj,
        corporate_name,
        trading_name,
        representative_name,
        representative_cpf,
        representative_email,
        admin_email,
        admin_password
    } = req.body;
    
    if (!tenant_id || !cnpj || !corporate_name || !representative_name || !representative_cpf || !representative_email || !admin_email || !admin_password) {
        return res.status(400).json({
            success: false,
            message: 'Preencha todos os campos obrigatórios'
        });
    }
    
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        // Verificar se tenant_id já existe
        const existing = await dbMaster.get('SELECT id FROM revendas WHERE tenant_id = ?', [tenant_id]);
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'Tenant ID já existe'
            });
        }
        
        // Inserir revenda
        const result = await dbMaster.run(
            `INSERT INTO revendas (tenant_id, cnpj, corporate_name, trading_name, representative_name, representative_cpf, representative_email, admin_email, admin_password)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenant_id, cnpj, corporate_name, trading_name || '', representative_name, representative_cpf, representative_email, admin_email, admin_password]
        );
        
        // Criar o tenant automaticamente
        try {
            const newDb = await dbManager.getConnection(tenant_id);
            await runMigrations(tenant_id);
            
            // Criar usuário admin
            const hashedPassword = await hashPassword(admin_password);
            await newDb.run(
                `INSERT INTO users (name, email, password_hash, role, active)
                 VALUES (?, ?, ?, ?, ?)`,
                [representative_name, admin_email, hashedPassword, 'revenda', 1]
            );
            
            // Criar empresa
            await newDb.run(
                `INSERT INTO companies (corporate_name, trading_name, cnpj, email, active)
                 VALUES (?, ?, ?, ?, ?)`,
                [corporate_name, trading_name || corporate_name, cnpj, admin_email, 1]
            );
            
            await dbManager.closeConnection(tenant_id);
        } catch (e) {
            logger.error('Erro ao criar tenant da revenda:', e);
        }
        
        res.status(201).json({
            success: true,
            message: 'Revenda criada com sucesso!',
            data: { id: result.lastID, tenant_id }
        });
    } catch (error) {
        logger.error('Erro ao criar revenda:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao criar revenda: ' + error.message
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

// Editar revenda
router.patch('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        cnpj,
        corporate_name,
        trading_name,
        representative_name,
        representative_cpf,
        representative_email,
        admin_email,
        admin_password,
        active
    } = req.body;
    
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        const updates = [];
        const params = [];
        
        if (cnpj) { updates.push('cnpj = ?'); params.push(cnpj); }
        if (corporate_name) { updates.push('corporate_name = ?'); params.push(corporate_name); }
        if (trading_name) { updates.push('trading_name = ?'); params.push(trading_name); }
        if (representative_name) { updates.push('representative_name = ?'); params.push(representative_name); }
        if (representative_cpf) { updates.push('representative_cpf = ?'); params.push(representative_cpf); }
        if (representative_email) { updates.push('representative_email = ?'); params.push(representative_email); }
        if (admin_email) { updates.push('admin_email = ?'); params.push(admin_email); }
        if (admin_password) { updates.push('admin_password = ?'); params.push(admin_password); }
        if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
        
        updates.push('updated_at = CURRENT_TIMESTAMP');
        
        params.push(id);
        
        await dbMaster.run(
            `UPDATE revendas SET ${updates.join(', ')} WHERE id = ?`,
            params
        );
        
        res.json({
            success: true,
            message: 'Revenda atualizada com sucesso!'
        });
    } catch (error) {
        logger.error('Erro ao atualizar revenda:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao atualizar revenda'
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

// Deletar revenda
router.delete('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        // Pegar o tenant_id antes de deletar
        const revenda = await dbMaster.get('SELECT tenant_id FROM revendas WHERE id = ?', [id]);
        
        if (revenda) {
            // Deletar revenda (isso também pode deletar os tenants relacionados se usar CASCADE)
            await dbMaster.run('DELETE FROM revendas WHERE id = ?', [id]);
        }
        
        res.json({
            success: true,
            message: 'Revenda deletada com sucesso!'
        });
    } catch (error) {
        logger.error('Erro ao deletar revenda:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao deletar revenda'
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

// Listar tenants de uma revenda
router.get('/tenants', asyncHandler(async (req, res) => {
    const tenantId = req.headers['x-tenant-id'];
    
    if (!tenantId) {
        return res.status(400).json({
            success: false,
            message: 'Tenant ID não fornecido'
        });
    }
    
    // Buscar a revenda pelo tenant_id
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        const revenda = await dbMaster.get('SELECT id FROM revendas WHERE tenant_id = ?', [tenantId]);
        
        if (!revenda) {
            return res.status(404).json({
                success: false,
                message: 'Revenda não encontrada'
            });
        }
        
        // Listar tenant_ids associados a esta revenda
        const revendaTenants = await dbMaster.all(
            'SELECT tenant_id FROM revenda_tenants WHERE revenda_id = ?',
            [revenda.id]
        );
        
        // Para cada tenant, buscar informações do banco de dados
        const tenants = await Promise.all(
            revendaTenants.map(async (rt) => {
                try {
                    const db = await dbManager.getConnection(rt.tenant_id);
                    
                    // Contar pessoas
                    const peopleResult = await db.get('SELECT COUNT(*) as count FROM persons WHERE status = ?', ['active']);
                    const personCount = peopleResult?.count || 0;
                    
                    // Contar veículos/equipamentos
                    const vehiclesResult = await db.get('SELECT COUNT(*) as count FROM vehicles');
                    const vehicleCount = vehiclesResult?.count || 0;
                    
                    // Ler limites
                    const limitsResult = await db.get('SELECT max_pessoas, max_equipamentos FROM tenant_limits LIMIT 1');
                    const maxPessoas = limitsResult?.max_pessoas || 1000;
                    const maxEquipamentos = limitsResult?.max_equipamentos || 50;
                    
                    // Ler info da empresa
                    const company = await db.get('SELECT corporate_name, cnpj FROM companies LIMIT 1');
                    const admin = await db.get('SELECT name, email, active FROM users WHERE role = ? LIMIT 1', ['admin']);
                    
                    await dbManager.closeConnection(rt.tenant_id);
                    
                    return {
                        tenant_id: rt.tenant_id,
                        company_name: company?.corporate_name || 'Sem nome',
                        cnpj: company?.cnpj || '',
                        admin_name: admin?.name || 'Admin',
                        admin_email: admin?.email || '',
                        pessoas_count: personCount,
                        max_pessoas: maxPessoas,
                        equipamentos_count: vehicleCount,
                        max_equipamentos: maxEquipamentos,
                        status: admin?.active === 1 ? 'active' : 'inactive'
                    };
                } catch (err) {
                    logger.warn(`Erro ao ler tenant ${rt.tenant_id}:`, err.message);
                    return {
                        tenant_id: rt.tenant_id,
                        company_name: 'Erro ao ler',
                        status: 'error'
                    };
                }
            })
        );
        
        res.json({
            success: true,
            data: tenants
        });
    } catch (error) {
        logger.error('Erro ao listar tenants da revenda:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao listar tenants'
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

// Bloquear revenda
router.post('/:id/block', asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    try {
        const revenda = await dbMaster.get('SELECT * FROM revendas WHERE id = ?', [id]);
        
        if (!revenda) {
            return res.status(404).json({
                success: false,
                message: 'Revenda não encontrada'
            });
        }
        
        // Inverter o status
        const newStatus = revenda.active ? 0 : 1;
        await dbMaster.run('UPDATE revendas SET active = ? WHERE id = ?', [newStatus, id]);
        
        res.json({
            success: true,
            message: newStatus ? 'Revenda desbloqueada com sucesso!' : 'Revenda bloqueada com sucesso!'
        });
    } catch (error) {
        logger.error('Erro ao bloquear revenda:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao bloquear revenda'
        });
    } finally {
        await dbManager.closeConnection('acesscontrolmaster');
    }
}));

export default router;

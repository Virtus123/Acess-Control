import dbManager from '../config/database.js';
import logger from '../config/logger.js';
import emailService from '../services/emailService.js';
import { hashPassword } from '../utils/generators.js';
import { validateEmail, validateCNPJ } from '../utils/validators.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { runMigrations } from '../database/migrate.js';
import fs from 'fs/promises';
import { dirname } from 'path';

/**
 * Criar novo tenant (cliente)
 * POST /api/admin/tenants
 * 
 * Body:
 * {
 *   tenant_id: "tenant_003",
 *   company_name: "Acme Corp",
 *   cnpj: "12345678000190",
 *   admin_email: "admin@acme.com",
 *   admin_password: "senha123",
 *   admin_name: "João Silva",
 *   phone: "1133334444",
 *   city: "São Paulo",
 *   state: "SP"
 * }
 */
export const createTenant = asyncHandler(async (req, res) => {
  console.trace('[createTenant] chamado com:', req.body.tenant_id);
  const currentTenantId = req.headers['x-tenant-id'];
  
  const {
    tenant_id,
    company_name,
    cnpj,
    admin_email,
    admin_password,
    admin_name,
    phone,
    city,
    state,
    max_pessoas = 1000,
    max_equipamentos = 50
  } = req.body;

  // Validações
  if (!tenant_id || !company_name || !cnpj || !admin_email || !admin_password || !admin_name) {
    return res.status(400).json({
      success: false,
      message: 'Preencha: tenant_id, company_name, cnpj, admin_email, admin_password, admin_name'
    });
  }

  // Validar comprimento tenant_id
  if (tenant_id.length < 2 || tenant_id.length > 50) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID deve ter entre 2 e 50 caracteres'
    });
  }

  // Validar caracteres permitidos (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(tenant_id)) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID deve conter apenas letras, números, hífen e underscore'
    });
  }

  // Validar CNPJ
  if (!validateCNPJ(cnpj)) {
    return res.status(400).json({
      success: false,
      message: 'CNPJ inválido'
    });
  }

  // Validar email
  if (!validateEmail(admin_email)) {
    return res.status(400).json({
      success: false,
      message: 'Email inválido'
    });
  }

  // Validar senha (mínimo 6 caracteres)
  if (admin_password.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Senha deve ter mínimo 6 caracteres'
    });
  }

  try {
    // 1. Verificar se tenant já existe
    const dbPath = dbManager.getTenantPath(tenant_id);
    try {
      await fs.access(dbPath);
      // Se chegou aqui, o arquivo já existe
      return res.status(409).json({
        success: false,
        message: `Tenant ${tenant_id} já existe`
      });
    } catch (err) {
      // Arquivo não existe (esperado)
    }

    // 2. Criar banco de dados do tenant
    const db = await dbManager.getConnection(tenant_id);

    // 3. Executar migrações (cria todas as tabelas com o schema correto)
    logger.info(`Executando migrações para ${tenant_id}...`);
    await runMigrations(tenant_id);
    logger.info(`✅ Migrações aplicadas para ${tenant_id}`);

    // 3.5. Atualizar limites
    await db.run(
      `UPDATE tenant_limits SET max_pessoas = ?, max_equipamentos = ?`,
      [max_pessoas, max_equipamentos]
    );

    // 4. Criar usuário admin
    const hashedPassword = await hashPassword(admin_password);
    
    await db.run(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES (?, ?, ?, ?, ?)`,
      [admin_name, admin_email, hashedPassword, 'admin', 1]
    );

    // 5. Criar empresa padrão
    await db.run(
      `INSERT INTO companies (corporate_name, trading_name, cnpj, email, phone, city, state, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name, company_name, cnpj, admin_email, phone || '', city || '', state || '', 1]
    );

    // 6. Fechar conexão
    await dbManager.closeConnection(tenant_id);

    // 7. Se a requisição veio de uma revenda, associar o novo tenant à revenda
    if (currentTenantId) {
      try {
        const dbMaster = await dbManager.getConnection('acesscontrolmaster');
        
        // Buscar a revenda pelo tenant_id (a própria revenda)
        const revenda = await dbMaster.get('SELECT id FROM revendas WHERE tenant_id = ?', [currentTenantId]);
        
        if (revenda) {
          // Associar o novo tenant à revenda
          await dbMaster.run(
            'INSERT OR IGNORE INTO revenda_tenants (revenda_id, tenant_id) VALUES (?, ?)',
            [revenda.id, tenant_id]
          );
          logger.info(`✅ Tenant ${tenant_id} associado à revenda ${currentTenantId}`);
        }
        
        await dbManager.closeConnection('acesscontrolmaster');
      } catch (e) {
        logger.error('Erro ao associar tenant à revenda:', e);
        // Não bloqueia a criação se falhar nesta etapa
      }
    }

    // 8. Tentar enviar email de boas-vindas
    await emailService.sendTenantCreatedEmail(admin_email, tenant_id, admin_password, company_name);

    logger.info(`✅ Tenant ${tenant_id} criado com sucesso!`);

    res.status(201).json({
      success: true,
      message: `Tenant ${tenant_id} criado com sucesso!`,
      data: {
        tenant_id,
        company_name,
        cnpj,
        admin_email,
        admin_name,
        phone,
        city,
        state,
        max_pessoas,
        max_equipamentos,
        pessoas_count: 0,
        equipamentos_count: 0,
        created_at: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error(`Erro ao criar tenant ${tenant_id}:`, error);
    
    // Tentar deletar database se houver erro
    try {
      const dbPath = dbManager.getTenantPath(tenant_id);
      await fs.unlink(dbPath);
    } catch (e) {
      // Ignorar erro de delete
    }

    res.status(500).json({
      success: false,
      message: 'Erro ao criar tenant',
      error: error.message
    });
  }
});

/**
 * Listar todos os tenants (apenas admin)
 * GET /api/admin/tenants
 */
export const listTenants = asyncHandler(async (req, res) => {
  const tenantDir = process.env.DATABASE_STORAGE || './database/tenants';
  
  try {
    const files = await fs.readdir(tenantDir);
    const tenantFiles = files
      .filter(f => f.endsWith('.db') && f.startsWith('tenant_'));

    // Buscar mapeamento de tenants->revendas no banco master
    let revendaMap = {}; // { tenant_id: { revenda_id, corporate_name } }
    try {
      const dbMaster = await dbManager.getConnection('acesscontrolmaster');
      const revendaLinks = await dbMaster.all(
        `SELECT rt.tenant_id, rt.revenda_id, r.corporate_name as revenda_name
         FROM revenda_tenants rt
         JOIN revendas r ON r.id = rt.revenda_id`
      );
      await dbManager.closeConnection('acesscontrolmaster');
      revendaLinks.forEach(l => { revendaMap[l.tenant_id] = { revenda_id: l.revenda_id, revenda_name: l.revenda_name }; });
    } catch (e) {
      logger.warn('Não foi possível carregar mapeamento de revendas:', e.message);
    }

    // Para cada tenant, tentar ler contadores e limites
    const tenants = await Promise.all(
      tenantFiles.map(async (f) => {
        const tenantId = f.replace('tenant_', '').replace('.db', '');
        try {
          const db = await dbManager.getConnection(tenantId);
          
          // Contar pessoas
          const peopleResult = await db.get('SELECT COUNT(*) as count FROM persons WHERE status = ?', ['active']);
          const personCount = peopleResult?.count || 0;
          
          // Contar veículos
          const vehiclesResult = await db.get('SELECT COUNT(*) as count FROM vehicles');
          const vehicleCount = vehiclesResult?.count || 0;
          
          // Ler limites
          const limitsResult = await db.get('SELECT max_pessoas, max_equipamentos FROM tenant_limits LIMIT 1');
          const maxPessoas = limitsResult?.max_pessoas || 1000;
          const maxEquipamentos = limitsResult?.max_equipamentos || 50;
          
          // Ler info da empresa
          const company = await db.get('SELECT corporate_name, cnpj FROM companies LIMIT 1');
          const admin = await db.get('SELECT name, email, active FROM users WHERE role = ? LIMIT 1', ['admin']);
          
          // Fechar conexão
          await dbManager.closeConnection(tenantId);
          
          const revendaInfo = revendaMap[tenantId] || null;

          return {
            tenant_id: tenantId,
            company_name: company?.corporate_name || 'Sem nome',
            cnpj: company?.cnpj || '',
            admin_name: admin?.name || 'Admin',
            admin_email: admin?.email || '',
            pessoas_count: personCount,
            max_pessoas: maxPessoas,
            equipamentos_count: vehicleCount,
            max_equipamentos: maxEquipamentos,
            status: admin?.active === 1 ? 'active' : 'inactive',
            revenda_id: revendaInfo?.revenda_id || null,
            revenda_name: revendaInfo?.revenda_name || null,
            created: new Date().toISOString()
          };
        } catch (err) {
          logger.warn(`Erro ao ler tenant ${tenantId}:`, err.message);
          return {
            tenant_id: tenantId,
            company_name: 'Erro ao ler',
            status: 'error',
            error: err.message
          };
        }
      })
    );

    res.json({
      success: true,
      count: tenants.length,
      data: tenants
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao listar tenants',
      error: error.message
    });
  }
});


/**
 * Deletar tenant (apenas admin, CUIDADO!)
 * DELETE /api/admin/tenants/:tenant_id
 */
export const deleteTenant = asyncHandler(async (req, res) => {
  const { tenant_id } = req.params;

  if (!tenant_id.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID inválido'
    });
  }

  try {
    const dbPath = dbManager.getTenantPath(tenant_id);
    
    // Fechar conexão se existir
    try {
      await dbManager.closeConnection(tenant_id);
    } catch (e) {
      // Ignorar
    }

    // Deletar arquivo
    await fs.unlink(dbPath);

    logger.warn(`❌ Tenant ${tenant_id} deletado!`);

    res.json({
      success: true,
      message: `Tenant ${tenant_id} deletado com sucesso!`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao deletar tenant',
      error: error.message
    });
  }
});

/**
 * Resetar senha do admin do tenant
 * POST /api/admin/tenants/:tenant_id/reset-password
 */
export const resetTenantPassword = asyncHandler(async (req, res) => {
  const { tenant_id } = req.params;
  
  if (!tenant_id.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID inválido'
    });
  }
  
  const newPassword = Math.random().toString(36).slice(-8) + '!Aa1'; // Gera senha aleatória

  try {
    const db = await dbManager.getConnection(tenant_id);
    const hashedPassword = await hashPassword(newPassword);

    const admin = await db.get('SELECT id, email FROM users WHERE role = ?', ['admin']);
    
    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin não encontrado para este tenant'
      });
    }

    await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hashedPassword, admin.id]
    );

    await dbManager.closeConnection(tenant_id);

    // Tentar enviar email
    await emailService.sendPasswordResetEmail(admin.email, tenant_id, newPassword);

    logger.info(`✅ Senha resetada para tenant ${tenant_id}`);

    res.json({
      success: true,
      message: `Senha resetada com sucesso! Nova senha: ${newPassword}`,
      data: {
        tenant_id,
        admin_email: admin.email,
        temporary_password: newPassword,
        note: 'Um email foi enviado para o administrador com a nova senha'
      }
    });
  } catch (error) {
    logger.error(`Erro ao resetar senha para ${tenant_id}:`, error);
    res.status(500).json({
      success: false,
      message: 'Erro ao resetar senha',
      error: error.message
    });
  }
});

/**
 * Desativar/Ativar tenant
 * PATCH /api/admin/tenants/:tenant_id/toggle-status
 */
export const toggleTenantStatus = asyncHandler(async (req, res) => {
  const { tenant_id } = req.params;
  const { active } = req.body;

  if (!tenant_id.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID inválido'
    });
  }

  try {
    const db = await dbManager.getConnection(tenant_id);
    
    // Desativar/Ativar o admin (todos os usuários)
    await db.run(
      'UPDATE users SET active = ?',
      [active ? 1 : 0]
    );

    await dbManager.closeConnection(tenant_id);

    logger.info(`✅ Tenant ${tenant_id} ${active ? 'ativado' : 'desativado'}!`);

    res.json({
      success: true,
      message: `Tenant ${active ? 'ativado' : 'desativado'} com sucesso!`,
      data: {
        tenant_id,
        status: active ? 'active' : 'inactive'
      }
    });
  } catch (error) {
    logger.error(`Erro ao alternar status do tenant ${tenant_id}:`, error);
    res.status(500).json({
      success: false,
      message: 'Erro ao alterar status do tenant',
      error: error.message
    });
  }
});

/**
 * Editar informações do tenant
 * PATCH /api/admin/tenants/:tenant_id
 */
export const editTenant = asyncHandler(async (req, res) => {
  const { tenant_id } = req.params;
  const { 
    company_name, 
    cnpj, 
    phone, 
    city, 
    state,
    max_pessoas,
    max_equipamentos
  } = req.body;

  if (!tenant_id.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({
      success: false,
      message: 'Tenant ID inválido'
    });
  }

  try {
    const db = await dbManager.getConnection(tenant_id);

    // Atualizar informações da empresa
    if (company_name || cnpj || phone || city || state) {
      const updateFields = [];
      const updateValues = [];

      if (company_name) {
        updateFields.push('corporate_name = ?', 'trading_name = ?');
        updateValues.push(company_name, company_name);
      }
      if (cnpj) {
        updateFields.push('cnpj = ?');
        updateValues.push(cnpj);
      }
      if (phone) {
        updateFields.push('phone = ?');
        updateValues.push(phone);
      }
      if (city) {
        updateFields.push('city = ?');
        updateValues.push(city);
      }
      if (state) {
        updateFields.push('state = ?');
        updateValues.push(state);
      }

      if (updateFields.length > 0) {
        await db.run(
          `UPDATE companies SET ${updateFields.join(', ')} WHERE id = (SELECT id FROM companies LIMIT 1)`,
          updateValues
        );
      }
    }

    // Atualizar limites se fornecidos
    if (max_pessoas !== undefined || max_equipamentos !== undefined) {
      const limitsFields = [];
      const limitsValues = [];

      if (max_pessoas !== undefined) {
        limitsFields.push('max_pessoas = ?');
        limitsValues.push(max_pessoas);
      }
      if (max_equipamentos !== undefined) {
        limitsFields.push('max_equipamentos = ?');
        limitsValues.push(max_equipamentos);
      }

      if (limitsFields.length > 0) {
        await db.run(
          `UPDATE tenant_limits SET ${limitsFields.join(', ')}`,
          limitsValues
        );
      }
    }

    // Buscar dados atualizados
    const company = await db.get('SELECT * FROM companies LIMIT 1');
    const limits = await db.get('SELECT * FROM tenant_limits LIMIT 1');

    await dbManager.closeConnection(tenant_id);

    logger.info(`✅ Tenant ${tenant_id} atualizado com sucesso`);

    res.json({
      success: true,
      message: `Tenant ${tenant_id} atualizado com sucesso!`,
      data: {
        tenant_id,
        company_name: company?.corporate_name,
        cnpj: company?.cnpj,
        phone: company?.phone,
        city: company?.city,
        state: company?.state,
        max_pessoas: limits?.max_pessoas,
        max_equipamentos: limits?.max_equipamentos
      }
    });
  } catch (error) {
    logger.error(`Erro ao editar tenant ${tenant_id}:`, error);
    res.status(500).json({
      success: false,
      message: 'Erro ao editar tenant',
      error: error.message
    });
  }
});

/**
 * Entrar em um tenant como admin (impersonate)
 * POST /api/admin/tenants/:tenant_id/impersonate
 */
export const impersonateTenant = asyncHandler(async (req, res) => {
  const { tenant_id } = req.params;
  const callerRole = req.user.role;
  const callerTenant = req.user.tenant_id;

  if (!tenant_id.match(/^[a-z0-9_-]+$/i)) {
    return res.status(400).json({ success: false, message: 'Tenant ID inválido' });
  }

  try {
    const dbMaster = await dbManager.getConnection('acesscontrolmaster');
    
    // Verificação de Segurança (Admin Master tem permissão total)
    const isMaster = req.user.is_master === true || (callerRole === 'admin' && callerTenant === 'acesscontrolmaster');
    
    if (isMaster) {
      // Admin Master: Tudo liberado
    } else if (callerRole === 'revenda' || callerRole === 'admin') {
      // É uma revenda ou admin de outra base? Verificar se o tenant pertence a ela
      const revenda = await dbMaster.get('SELECT id FROM revendas WHERE tenant_id = ?', [callerTenant]);
      if (!revenda) {
        await dbManager.closeConnection('acesscontrolmaster');
        return res.status(403).json({ success: false, message: 'Acesso negado. Sua conta não tem permissão de revendedor para acessar outras bases.' });
      }
      
      const associacao = await dbMaster.get(
        'SELECT 1 FROM revenda_tenants WHERE revenda_id = ? AND tenant_id = ?',
        [revenda.id, tenant_id]
      );
      
      if (!associacao) {
        await dbManager.closeConnection('acesscontrolmaster');
        return res.status(403).json({ success: false, message: 'Acesso negado. Esta base não pertence à sua revenda.' });
      }
    } else {
      await dbManager.closeConnection('acesscontrolmaster');
      return res.status(403).json({ success: false, message: `Permissão insuficiente para impersonation. Role: ${callerRole}, Tenant: ${callerTenant}` });
    }
    
    await dbManager.closeConnection('acesscontrolmaster');

    const db = await dbManager.getConnection(tenant_id);
    const admin = await db.get(
      "SELECT id, name, email, role FROM users WHERE role IN ('admin', 'revenda') LIMIT 1"
    );
    await dbManager.closeConnection(tenant_id);

    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin não encontrado para este tenant' });
    }

    const { generateTokens } = await import('../middleware/auth.js');
    const { accessToken } = generateTokens({
      id: admin.id,
      email: admin.email,
      role: admin.role,
      userType: 'operator',
      tenant_id: tenant_id,
      is_master: req.user.is_master // Propagar flag de Master
    });

    logger.info(`Caller ${callerTenant} (Master: ${req.user.is_master}) acessou tenant ${tenant_id} como ${admin.email}`);

    res.json({ success: true, data: { accessToken, tenant_id, admin_email: admin.email } });
  } catch (error) {
    logger.error(`Erro ao impersonar tenant ${tenant_id}:`, error);
    res.status(500).json({ success: false, message: 'Erro ao acessar tenant', error: error.message });
  }
});

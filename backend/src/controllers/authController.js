import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { generateTokens, verifyRefreshToken } from '../middleware/auth.js';
import { formatUser } from '../utils/formatters.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../config/logger.js';
import { verifyPassword, hashPassword } from '../utils/generators.js';
import dbManager from '../config/database.js';
import securityDb from '../config/securityDb.js';
import auditService from '../services/auditService.js';

// Lista de IPs com tentativas falhas (importar do middleware)
const blockedIPs = new Map();
const MAX_LOGIN_ATTEMPTS = 1000;

// Garantir que a coluna profile_id existe na tabela users
async function ensureProfileIdColumn(db) {
  try {
    const tableInfo = await db.all("PRAGMA table_info(users)");
    const hasProfileId = tableInfo.some(col => col.name === 'profile_id');
    if (!hasProfileId) {
      await db.run('ALTER TABLE users ADD COLUMN profile_id INTEGER REFERENCES authorization_profiles(id)');
      console.log('[AUTH] Coluna profile_id adicionada à tabela users');
    }
  } catch (error) {
    console.error('[AUTH] Erro ao garantir coluna profile_id:', error.message);
  }
}

// Obter permissões do perfil do usuário
async function getUserPermissions(db, profileId) {
  if (!profileId) return null;
  
  try {
    let permissions = await db.all(`
      SELECT module, resource, can_view, can_create, can_edit, can_delete, can_execute
      FROM authorization_permissions 
      WHERE profile_id = ?
    `, [profileId]);
    
    // Se não tem permissões, retorna vazio (sem acesso por padrão)
    if (!permissions || permissions.length === 0) {
      console.log('[AUTH] Nenhuma permissão configurada para o perfil:', profileId);
      return [];
    }
    
    return permissions;
  } catch (error) {
    console.error('Erro ao buscar permissões:', error);
    return [];
  }
}

async function recordFailedAttempt(ip, identifier) {
  try {
    await securityDb.recordFailure(ip, identifier);
  } catch (error) {
    logger.error(`Erro ao registrar falha de login para ${identifier}:`, error);
  }
}

async function clearFailedAttempts(ip, identifier) {
  try {
    await securityDb.resetAttempts(ip, identifier);
  } catch (error) {
    logger.error(`Erro ao limpar falhas de login para ${identifier}:`, error);
  }
}

async function getSecurityDelay(ip, identifier) {
  try {
    const attempt = await securityDb.getAttempt(ip, identifier);
    if (attempt && attempt.delay_until) {
      const delayUntil = new Date(attempt.delay_until);
      const now = new Date();
      if (delayUntil > now) {
        return delayUntil.getTime() - now.getTime();
      }
    }
  } catch (error) {
    logger.error('Erro ao verificar delay de segurança:', error);
  }
  return 0;
}

// Varre todos os tenants para encontrar qual contém o e-mail informado.
// Usado quando o usuário não fornece tenantId (novo comportamento padrão).
async function findTenantByEmail(email) {
  const tenants = await dbManager.listTenants();
  for (const id of tenants) {
    try {
      const db = await dbManager.getConnection(id);
      const inUsers   = await db.get('SELECT id FROM users   WHERE email = ? AND active = 1',           [email]);
      if (inUsers) return id;
      const inPersons = await db.get('SELECT id FROM persons WHERE email = ? AND status = "active"',    [email]);
      if (inPersons) return id;
    } catch {
      // tenant com DB corrompido: ignora e continua
    }
  }
  return null;
}

export const login = asyncHandler(async (req, res) => {
  const { email, password, tenantId: bodyTenantId } = req.body;
  const ip = req.ip || req.connection?.remoteAddress;

  // 1. Verificar Delay Progressivo (Anti-Brute Force)
  const delay = await getSecurityDelay(ip, email);
  if (delay > 0) {
    return res.status(429).json({
      success: false,
      message: `Muitas tentativas. Tente novamente em ${Math.ceil(delay / 1000)} segundos.`,
      retryAfter: Math.ceil(delay / 1000)
    });
  }

  // Obter tenant: prioridade body > header > auto-descoberta por e-mail
  let tenantId = bodyTenantId || req.headers['x-tenant-id'];

  if (!tenantId) {
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email e senha são obrigatórios' });
    }
    tenantId = await findTenantByEmail(email);
    if (!tenantId) {
      await recordFailedAttempt(ip, email);
      return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }
  } else {
    // tenantId fornecido: validar se existe antes de abrir conexão
    const tenantDbPath = dbManager.getTenantPath(tenantId);
    try {
      await import('fs/promises').then(fs => fs.access(tenantDbPath));
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Tenant não encontrado. Verifique o ID da base e tente novamente.'
      });
    }
  }

  const db = await dbManager.getConnection(tenantId);
  const dbMaster = await dbManager.getConnection('mamcontrolmam');

  
  // Garantir que a coluna profile_id existe na tabela users
  await ensureProfileIdColumn(db);


  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email e senha são obrigatórios'
    });
  }

  // Tentar encontrar na tabela users (Operadores/Admins)
  let user = await db.get(
    'SELECT * FROM users WHERE email = ? AND active = 1',
    [email]
  );
  
  let userType = 'operator';
  let mobilePermissions = null;

  if (!user) {
    // Tentar encontrar na tabela persons (Pessoas da Empresa)
    user = await db.get(
      'SELECT id, name, email, password_hash, company_id, role, mobile_permissions FROM persons WHERE email = ? AND status = "active"',
      [email]
    );
    
    if (user) {
      userType = 'person';
      user.role = user.role || 'person';
      try {
        mobilePermissions = user.mobile_permissions ? JSON.parse(user.mobile_permissions) : ['equipments', 'encomendas', 'monitoramento'];
      } catch (e) {
        mobilePermissions = ['equipments', 'encomendas', 'monitoramento'];
      }
    }
  }

  if (!user) {
    await recordFailedAttempt(ip, email);
    return res.status(401).json({
      success: false,
      message: 'Credenciais inválidas'
    });
  }

  logger.info(`Login attempt for ${email} in tenant ${tenantId}, user type: ${userType}`);
  
  // Verificar se a senha foi definida (especialmente para moradores recém-migrados)
  if (userType === 'person' && !user.password_hash) {
    return res.status(401).json({
      success: false,
      message: 'Senha de acesso mobile não configurada. Por favor, solicite a um administrador.'
    });
  }

  // Verificar senha
  const isValidPassword = await verifyPassword(password, user.password_hash);

  if (!isValidPassword) {
    await recordFailedAttempt(ip, email);
    return res.status(401).json({
      success: false,
      message: 'Credenciais inválidas'
    });
  }
  
  // Login bem sucedido: Resetar tentativas
  await clearFailedAttempts(ip, email);
  
  const { accessToken, refreshToken } = generateTokens({
    id: user.id,
    email: user.email,
    role: user.role,
    company_id: user.company_id || null,
    userType,
    tenant_id: tenantId
  });

  // Obter perfil e permissões do usuário (apenas para Operadores)
  let profilePermissions = [];
  let profileName = null;
  
  if (userType === 'operator' && user.profile_id) {
    try {
      const profile = await db.get('SELECT name FROM authorization_profiles WHERE id = ?', [user.profile_id]);
      if (profile) profileName = profile.name;
      profilePermissions = await getUserPermissions(db, user.profile_id);
    } catch (e) {
      console.log('Erro ao buscar perfil:', e.message);
    }
  }

  // Determinar URL de redirecionamento (para web)
  let redirectUrl = '/dashboard';
  if (userType === 'operator') {
    if (tenantId === 'mamcontrolmam' && user.role === 'admin') {
      redirectUrl = '/admin-master.html';
    } else {
      // Verificar se este tenant_id é uma revenda registrada no master
      const isRevenda = await dbMaster.get('SELECT id FROM revendas WHERE tenant_id = ?', [tenantId]);
      if (isRevenda || user.role === 'revenda') {
        redirectUrl = '/admin-revenda.html';
      } else {
        redirectUrl = '/dashboard';
      }
    }
  } else {
    redirectUrl = '/mobile-me.html'; // Pessoas logando na web? Redireciona para perfil básico
  }

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company_id: user.company_id || null,
        mobilePermissions,
        profile_id: user.profile_id
      },
      tenantId,
      accessToken,
      refreshToken,
      redirectUrl,
      profilePermissions,
      profileName,
      userType
    },
    message: 'Login realizado com sucesso'
  });

  // Log audit
  await auditService.logAction({
      tenant_id: tenantId,
      user_id: user.id,
      user_name: user.name,
      action: 'LOGIN',
      entity_type: userType,
      entity_id: user.id,
      description: `Login realizado via ${userType === 'operator' ? 'Usuários' : 'Pessoas'}: ${user.name} (${user.email})`,
      ip_address: req.ip || req.connection?.remoteAddress,
      user_agent: req.headers['user-agent']
  });
});

/**
 * Login para Mobile usando CPF e Tenant ID
 */
export const loginMobile = asyncHandler(async (req, res) => {
  const { cpf } = req.body;
  const tenantId = req.headers['x-tenant-id'];

  if (!cpf || !tenantId) {
    return res.status(400).json({
      success: false,
      message: 'CPF e X-Tenant-ID são obrigatórios.'
    });
  }

  const ip = req.ip || req.connection?.remoteAddress;
  
  // 1. Verificar Delay Progressivo (Anti-Brute Force)
  const delay = await getSecurityDelay(ip, cpf);
  if (delay > 0) {
    return res.status(429).json({
      success: false,
      message: `Muitas tentativas. Tente novamente em ${Math.ceil(delay / 1000)} segundos.`,
      retryAfter: Math.ceil(delay / 1000)
    });
  }

  // 2. Verificar se o tenant existe antes de conectar
  const exists = await dbManager.tenantExists(tenantId);
  if (!exists) {
    return res.status(404).json({
      success: false,
      message: 'UNIDADE NÃO LOCALIZADA'
    });
  }

  const db = await dbManager.getConnection(tenantId);
  
  // Buscar a pessoa pelo CPF
  // Limpar CPF de caracteres não numéricos para comparação
  const cleanCpf = cpf.replace(/\D/g, '');
  
  const person = await db.get(
    'SELECT id, name, cpf, email, company_id, status, role FROM persons WHERE (cpf = ? OR REPLACE(REPLACE(cpf, ".", ""), "-", "") = ?) AND status = "active"',
    [cpf, cleanCpf]
  );

  if (!person) {
    await recordFailedAttempt(ip, cpf);
    return res.status(401).json({
      success: false,
      message: 'Usuário não encontrado ou inativo para este Tenant.'
    });
  }
  
  // Resetar falhas em caso de sucesso
  await clearFailedAttempts(ip, cpf);

  // Gerar tokens especiais para mobile (isMobile: true)
  const userPayload = {
    id: person.id,
    name: person.name,
    cpf: person.cpf,
    email: person.email,
    role: person.role || 'person',
    company_id: person.company_id,
    isMobile: true,
    tenant_id: tenantId
  };

  const { accessToken, refreshToken } = generateTokens(userPayload);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    data: {
      user: {
        id: person.id,
        name: person.name,
        role: person.role || 'person',
        company_id: person.company_id
      },
      accessToken,
      refreshToken
    },
    message: 'Login mobile realizado com sucesso'
  });

  // Log audit
  await auditService.logAction({
      tenant_id: tenantId,
      user_id: person.id,
      user_name: person.name,
      action: 'LOGIN_MOBILE',
      entity_type: 'person',
      entity_id: person.id,
      description: `Login mobile realizado via CPF: ${person.name} (${person.cpf})`,
      ip_address: req.ip || req.connection?.remoteAddress,
      user_agent: req.headers['user-agent']
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken || req.body.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({
      success: false,
      message: 'Refresh token não fornecido'
    });
  }

  const decoded = verifyRefreshToken(refreshToken);
  const db = req.db;

  const user = await db.get(
    'SELECT * FROM users WHERE id = ? AND active = 1',
    [decoded.id]
  );

  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Usuário não encontrado'
    });
  }

  const { accessToken, refreshToken: newRefreshToken } = generateTokens({
    ...user,
    tenant_id: decoded.tenant_id
  });

  res.cookie('refreshToken', newRefreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken: newRefreshToken
    }
  });
});

export const logout = asyncHandler(async (req, res) => {
  res.clearCookie('refreshToken');
  res.json({
    success: true,
    message: 'Logout realizado com sucesso'
  });
});

export const me = asyncHandler(async (req, res) => {
  const db = req.db;
  const user = await db.get(
    'SELECT * FROM users WHERE id = ?',
    [req.user.id]
  );

  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Usuário não encontrado'
    });
  }

  res.json({
    success: true,
    data: formatUser(user)
  });
});

export const register = asyncHandler(async (req, res) => {
  const { name, email, password, role = 'viewer', profile_id } = req.body;
  const db = req.db;

  if (!name || !email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Nome, email e senha são obrigatórios'
    });
  }

  const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);

  if (existingUser) {
    return res.status(400).json({
      success: false,
      message: 'Email já cadastrado'
    });
  }

  const passwordHash = await hashPassword(password);

  // profile_id é opcional
  const profileIdValue = profile_id || null;

  const result = await db.run(
    `INSERT INTO users (name, email, password_hash, role, active, profile_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      passwordHash,
      role,
      1,
      profileIdValue
    ]
  );

  const newUser = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);

  res.status(201).json({
    success: true,
    data: formatUser(newUser),
    message: 'Usuário criado com sucesso'
  });

  // Log audit
  await auditService.logCreate(req, 'user', newUser.id, `Criação de usuário: ${newUser.name} (${newUser.email})`, newUser);
});

export const getUsers = asyncHandler(async (req, res) => {
  const db = req.db;
  const users = await db.all('SELECT id, name, email, role, active, profile_id, created_at FROM users ORDER BY created_at DESC');
  
  // Buscar nomes dos perfis
  const usersWithProfiles = await Promise.all(users.map(async (user) => {
    let profileName = null;
    if (user.profile_id) {
      try {
        const profile = await db.get('SELECT name FROM authorization_profiles WHERE id = ?', [user.profile_id]);
        if (profile) {
          profileName = profile.name;
        }
      } catch (e) {
        // Ignora
      }
    }
    return {
      ...user,
      profileName,
      permissions: user.permissions ? JSON.parse(user.permissions) : {}
    };
  }));
  
  res.json({
    success: true,
    data: usersWithProfiles
  });
});

export const getUser = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Usuário não encontrado'
    });
  }
  
  // Buscar nome do perfil se existir
  let profileName = null;
  if (user.profile_id) {
    try {
      const profile = await db.get('SELECT name FROM authorization_profiles WHERE id = ?', [user.profile_id]);
      if (profile) {
        profileName = profile.name;
      }
    } catch (e) {
      // Ignora erro
    }
  }
  
  res.json({
    success: true,
    data: {
      ...formatUser(user),
      profile_id: user.profile_id,
      profileName
    }
  });
});

export const updateUser = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, email, password, role, permissions, active, profile_id } = req.body;
  
  const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Usuário não encontrado'
    });
  }

  // Buscar valores antigos para o log
  const oldValues = { ...user };
  delete oldValues.password_hash; // Segurança

  const updates = [];
  const values = [];
  
  if (name) {
    updates.push('name = ?');
    values.push(name);
  }
  
  if (email) {
    updates.push('email = ?');
    values.push(email);
  }
  
  if (password) {
    const passwordHash = await hashPassword(password);
    updates.push('password_hash = ?');
    values.push(passwordHash);
  }
  
  if (role) {
    updates.push('role = ?');
    values.push(role);
  }
  
  if (permissions !== undefined) {
    updates.push('permissions = ?');
    values.push(JSON.stringify(permissions));
  }
  
  if (active !== undefined) {
    updates.push('active = ?');
    values.push(active ? 1 : 0);
  }
  
  // Adicionar suporte a profile_id
  if (profile_id !== undefined) {
    updates.push('profile_id = ?');
    values.push(profile_id);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum campo para atualizar'
    });
  }
  
  values.push(id);
  
  await db.run(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    values
  );
  
  const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  
  res.json({
    success: true,
    data: formatUser(updatedUser),
    message: 'Usuário atualizado com sucesso'
  });

  // Log audit
  const newValues = { ...updatedUser };
  delete newValues.password_hash;
  await auditService.logUpdate(req, 'user', id, `Atualização de usuário: ${updatedUser.email}`, oldValues, newValues);
});

export const deleteUser = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  
  // Não permitir excluir o próprio usuário
  if (id == req.user.id) {
    return res.status(400).json({
      success: false,
      message: 'Você não pode excluir seu próprio usuário'
    });
  }
  
  const user = await db.get('SELECT id FROM users WHERE id = ?', [id]);
  
  if (!user) {
    return res.status(404).json({
      success: false,
      message: 'Usuário não encontrado'
    });
  }
  
  await db.run('DELETE FROM users WHERE id = ?', [id]);
  
  res.json({
    success: true,
    message: 'Usuário excluído com sucesso'
  });

  // Log audit
  await auditService.logDelete(req, 'user', id, `Exclusão de usuário: ${user.email}`, user);
});




import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';
import dbManager from '../config/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_SECRET_OLD = process.env.JWT_SECRET_OLD; // Segredo anterior para grace period
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key';

// Lista de IPs bloqueados (em memória - em produção usar Redis)
const blockedIPs = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const BLOCK_DURATION = 24 * 60 * 60 * 1000; // 24 horas (1 dia)

// IPs confiáveis (nunca bloqueados)
const TRUSTED_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];

function isTrustedIP(ip) {
  return TRUSTED_IPS.includes(ip) || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
}

function isIPBlocked(ip) {
  // IPs confiáveis nunca são bloqueados
  if (isTrustedIP(ip)) return false;
  
  const blockData = blockedIPs.get(ip);
  if (!blockData) return false;
  
  if (Date.now() > blockData.unblockTime) {
    blockedIPs.delete(ip);
    return false;
  }
  
  return true;
}

function blockIP(ip) {
  blockedIPs.set(ip, {
    attempts: 0,
    unblockTime: Date.now() + BLOCK_DURATION
  });
}

function recordFailedAttempt(ip) {
  let blockData = blockedIPs.get(ip);
  
  if (!blockData) {
    blockData = { attempts: 0, unblockTime: Date.now() + BLOCK_DURATION };
  }
  
  blockData.attempts++;
  
  if (blockData.attempts >= MAX_LOGIN_ATTEMPTS) {
    logger.warn(`IP ${ip} bloqueado por excesso de tentativas`);
    blockData.unblockTime = Date.now() + BLOCK_DURATION;
  }
  
  blockedIPs.set(ip, blockData);
}

function clearFailedAttempts(ip) {
  blockedIPs.delete(ip);
}

export function generateTokens(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    isMobile: user.isMobile || false,
    userType: user.userType || (user.isMobile ? 'person' : 'operator'),
    company_id: user.company_id || null,
    tenant_id: user.tenant_id,
    is_master: user.tenant_id === 'mamcontrolmam' || user.is_master || false
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '1h' // Reduzido de 1d para 1h por segurança
  });

  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_SECRET_EXPIRES_IN || '7d'
  });

  return { accessToken, refreshToken };
}

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

export function verifyAccessToken(token) {
  try {
    // 1. Tenta validar com o segredo administrativo (MPanel)
    if (ADMIN_JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
        if (decoded.type === 'admin') return decoded;
      } catch (e) {
        // Ignora e tenta o próximo segredo
      }
    }

    // 2. Tenta validar com o segredo atual (Novo - Tenants)
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    // 3. Se falhar e existir um segredo antigo, tenta o fallback (Grace Period)
    if (JWT_SECRET_OLD) {
      try {
        return jwt.verify(token, JWT_SECRET_OLD);
      } catch (oldError) {
        throw new Error('Token inválido ou expirado');
      }
    }
    throw new Error('Token inválido ou expirado');
  }
}

export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, JWT_REFRESH_SECRET);
  } catch (error) {
    throw new Error('Refresh token inválido ou expirado');
  }
}

export async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies.accessToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token de acesso não fornecido'
      });
    }

    const decoded = verifyAccessToken(token);
    
    // Suporte a Tokens Administrativos (MPanel)
    if (decoded.type === 'admin') {
      req.user = {
        id: decoded.admin_id,
        email: decoded.email,
        role: decoded.role === 'super_admin' ? 'admin' : decoded.role,
        is_master: decoded.role === 'super_admin',
        tenant_id: 'mamcontrolmam',
        userType: 'operator'
      };
      return next();
    }

    req.user = decoded;

    // Verificar se é rota de admin (não requer tenant)
    const fullPath = req.originalUrl || req.url || req.path;
    const isAdminRoute = fullPath.startsWith('/admin') || fullPath.startsWith('/api/admin') || 
                         fullPath.startsWith('/revendas') || fullPath.startsWith('/api/revendas') ||
                         fullPath.startsWith('/prices') || fullPath.startsWith('/api/prices');
    
    let db = req.db;
    
    if (!db && isAdminRoute) {
      db = await dbManager.getConnection('mamcontrolmam');
    }
    
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Erro ao conectar com banco de dados'
      });
    }

    let user;
    // Use userType if available, otherwise fallback to isMobile logic
    const userType = decoded.userType || (decoded.isMobile ? 'person' : 'operator');

    if (userType === 'person') {
      // Buscar na tabela persons para usuários person/mobile
      user = await db.get(
        'SELECT id, name, email, company_id, status, role, mobile_permissions FROM persons WHERE id = ? AND status = ?',
        [decoded.id, 'active']
      );
      
      if (user) {
        user.userType = 'person';
        user.role = user.role || 'person';
        user.isMobile = true;
      }
    } else {
      // Garantir que a coluna profile_id existe na tabela users (apenas para operators)
      try {
        const tableInfo = await db.all("PRAGMA table_info(users)");
        const hasProfileId = tableInfo.some(col => col.name === 'profile_id');
        if (!hasProfileId) {
          await db.run('ALTER TABLE users ADD COLUMN profile_id INTEGER REFERENCES authorization_profiles(id)');
        }
      } catch (e) {}
      
      user = await db.get(
        'SELECT id, name, email, role, active, profile_id FROM users WHERE id = ? AND active = 1',
        [decoded.id]
      );

      if (user) {
        user.userType = 'operator';
      }
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não encontrado ou inativo'
      });
    }

    req.user = {
      ...decoded,
      ...user
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'Erro na autenticação'
    });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não autenticado'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Acesso negado. Permissão insuficiente.'
      });
    }

    next();
  };
}

export function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuário não autenticado'
      });
    }

    // Admin sempre tem acesso
    if (req.user.role === 'admin') {
      return next();
    }

    // Permissões para usuários person (mobile app)
    if (req.user.userType === 'person') {
      let mobilePerms = [];
      try {
        mobilePerms = typeof req.user.mobile_permissions === 'string' 
          ? JSON.parse(req.user.mobile_permissions) 
          : (req.user.mobile_permissions || []);
      } catch (e) {
        mobilePerms = ['equipments', 'packages', 'monitoring']; // Fallback
      }

      // Mapeamento de permissões do backend para os nomes usados no mobile app
      const backendToMobileMap = {
        'equipments': 'equipments',
        'equipamentos': 'equipments',
        'encomendas': 'packages',
        'packages': 'packages',
        'visitors': 'visitors',
        'visitantes': 'visitors',
        'monitoring': 'monitoring',
        'accessLog': 'monitoring',
        'vehicles': 'vehicles',
        'veiculos': 'vehicles'
      };

      const mobilePermName = backendToMobileMap[permission] || permission;
      
      if (Array.isArray(mobilePerms) ? mobilePerms.includes(mobilePermName) : mobilePerms[mobilePermName]) {
        return next();
      }      return res.status(403).json({
        success: false,
        message: 'Acesso negado. Você não tem permissão para esta funcionalidade no app.'
      });
    }

    // Se não tem profile_id, cria um perfil padrão automaticamente
    if (!req.user.profile_id) {      try {
        const db = req.db;
        
        // Criar perfil padrão
        const result = await db.run(
          `INSERT INTO authorization_profiles (name, description, role, is_default) 
           VALUES (?, ?, ?, ?)`,
          ['Padrão', 'Perfil padrão do sistema', 'operador', 0]
        );
        
        const profileId = result.lastID;
        
        // Atualizar usuário com o novo profile_id
        await db.run('UPDATE users SET profile_id = ? WHERE id = ?', [profileId, req.user.id]);
        
        // Atualizar o profile_id na requisição
        req.user.profile_id = profileId;      } catch (err) {
        console.error('[AUTH] Erro ao criar perfil padrão:', err);
        return res.status(500).json({
          success: false,
          message: 'Erro ao criar perfil de acesso.'
        });
      }
    }

    try {
      // Buscar permissões do perfil
      const db = req.db;
      let permissions = await db.all(
        `SELECT module, resource, can_view, can_create, can_edit, can_delete, can_execute
         FROM authorization_permissions 
         WHERE profile_id = ?`,
        [req.user.profile_id]
      );

      // Lista de permissões padrão necessárias
      const defaultPermissions = [
        { module: 'pessoas', resource: 'pessoas', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'grupos', resource: 'grupos', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'empresas', resource: 'empresas', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'visitantes', resource: 'visitantes', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'veiculos', resource: 'veiculos', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'estacionamentos', resource: 'estacionamentos', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'refeitorio', resource: 'refeitorio', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'encomendas', resource: 'encomendas', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'claviculario', resource: 'claviculario', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'horarios', resource: 'horarios', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'equipamentos', resource: 'equipamentos', can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_execute: 0 },
        { module: 'relatorios', resource: 'relatorios', can_view: 1, can_create: 0, can_edit: 0, can_delete: 0, can_execute: 0 },
        { module: 'exports', resource: 'exports', can_view: 1, can_create: 1, can_edit: 0, can_delete: 0, can_execute: 0 }
      ];

      // Se não tem permissões OU se tem menos que o esperado, cria/atualiza permissões padrão
      // Sempre garante permissões mínimas para não quebrar o sistema
      if (!permissions || permissions.length < defaultPermissions.length) {        try {
          // Primeiro, deleta todas as permissões existentes
          await db.run('DELETE FROM authorization_permissions WHERE profile_id = ?', [req.user.profile_id]);
          
          // Agora cria todas as permissões padrão
          for (const perm of defaultPermissions) {
            await db.run(
              `INSERT INTO authorization_permissions (profile_id, module, resource, can_view, can_create, can_edit, can_delete, can_execute)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [req.user.profile_id, perm.module, perm.resource, perm.can_view, perm.can_create, perm.can_edit, perm.can_delete, perm.can_execute]
            );
          }

          // Recarrega as permissões
          permissions = await db.all(
            `SELECT module, resource, can_view, can_create, can_edit, can_delete, can_execute
             FROM authorization_permissions 
             WHERE profile_id = ?`,
            [req.user.profile_id]
          );
        } catch (permError) {
          console.error('[AUTH] Erro ao criar permissões:', permError.message);
          // Se der erro, usa as permissões existentes ou array vazio
          permissions = permissions || [];
        }
      }

      // Mapeamento de permissões do frontend para o backend
      const permissionMap = {
        'persons': 'pessoas',
        'groups': 'grupos',
        'companies': 'empresas',
        'vehicles': 'veiculos',
        'parkings': 'estacionamentos',
        'refeitorios': 'refeitorio',
        'encomendas': 'encomendas',
        'claviculario': 'claviculario',
        'visitors': 'lista',
        'visitor-cad': 'cadastro',
        'accessLog': 'pessoas',
        'accessLogVehicles': 'veiculos',
        'horarios': 'horarios',
        'feriados': 'feriados',
        'equipments': 'cadastro',
        'equip-status': 'status',
        'reports': 'relatorios',
        'exports': 'exports',
        'users': 'usuarios',
        'auditoria': 'auditoria'
      };

      // Verificar se tem a permissão necessária
      // permission pode ser string (ex: 'persons') ou objeto {module, resource}
      let requiredModule, requiredResource;
      
      if (typeof permission === 'string') {
        // Converter para o formato do banco
        requiredResource = permissionMap[permission] || permission;
      } else if (permission && typeof permission === 'object') {
        requiredModule = permission.module;
        requiredResource = permissionMap[permission.resource] || permission.resource;
      }

      const hasPermission = permissions.some(p => {
        const canView = p.can_view === 1 || p.can_view === true;
        if (!canView) return false;

        // Se especificou module, verifica ambos
        if (requiredModule && p.module === requiredModule) {
             if (p.resource === requiredResource) return true;
             // Legacy fallback dentro de módulos específicos
             if (requiredModule === 'visitantes' && p.resource === 'visitantes') return true;
             if (requiredModule === 'equipamentos' && p.resource === 'equipamentos') return true;
             return false;
        }

        // Se não especificou module ou module combinou, verifica resource com fallback legado
        if (p.resource === requiredResource) return true;

        // Mapeamento de recursos legados para recursos atuais
        const legacyMap = {
            'lista': 'visitantes',
            'cadastro': ['visitantes', 'equipamentos'], // Múltiplos legados podem mapear para o mesmo novo
            'pessoas': 'accessLog',
            'usuarios': 'configuracoes'
        };

        if (requiredResource === 'lista' && p.resource === 'visitantes') return true;
        if (requiredResource === 'cadastro' && (p.resource === 'visitantes' || p.resource === 'equipamentos')) return true;
        if (requiredResource === 'pessoas' && p.resource === 'accessLog') return true;
        if (requiredResource === 'usuarios' && p.resource === 'configuracoes') return true;

        return false;
      });

      if (hasPermission) {
        // Armazenar permissões no request para uso posterior
        req.user.permissions = permissions;
        return next();
      }

      // Log de autorização negada      return res.status(403).json({
        success: false,
        message: 'Acesso negado. Permissão insuficiente.'
      });

    } catch (error) {
      console.error('Erro ao verificar permissão:', error);
      return res.status(403).json({
        success: false,
        message: 'Acesso negado. Erro interno ao verificar permissão.'
      });
    }
  };
}

// Alias para requireRole
export const requireAdmin = requireRole('admin');
export const requireOperator = requireRole('operator', 'admin');




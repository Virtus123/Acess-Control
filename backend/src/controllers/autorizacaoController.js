/**
 * Controller de Autorização de Acesso
 * Responsável por processar requests de acesso vindas do comunicador
 * Inclui lógica de inativação automática de visitantes em equipamentos de saída
 */

import { getTenantDatabase } from '../middleware/tenantManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  processarAcesso as executarAutorizacao,
  confirmarAcessoDirection,
  invalidateCache,
  getCacheDebugInfo
} from '../services/autorizadorService.js';
import logger from '../config/logger.js';

// Logging de cada acesso é caro no hot path (JSON.stringify síncrono).
// Habilitar somente quando AUTHORIZER_DEBUG=true para troubleshooting pontual.
const VERBOSE_LOG = process.env.AUTHORIZER_DEBUG === 'true';

// ============================================
// ROTAS PÚBLICAS DO COMUNICADOR
// ============================================

export const processarAcesso = asyncHandler(async (req, res) => {
  const { tenant_id, equip_validator, user_id, person_type, timestamp } = req.body;

  // Validação de parâmetros obrigatórios
  if (!tenant_id || !equip_validator || !user_id) {
    return res.status(400).json({
      success: false,
      status: false,
      message: 'Parâmetros obrigatórios: tenant_id, equip_validator, user_id'
    });
  }

  try {
    if (VERBOSE_LOG) {
      logger.debug('[autorizacao] request', { tenant_id, equip_validator, user_id });
    }

    const result = await executarAutorizacao(tenant_id, equip_validator, user_id);

    if (VERBOSE_LOG) {
      logger.debug('[autorizacao] response', {
        tenant_id, equip_validator, user_id,
        allowed: result.allowed, message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      status: result.allowed,
      message: result.message,
      data: result.data
    });

  } catch (error) {
    logger.error('[autorizacao] erro', {
      tenant_id, equip_validator, user_id,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      status: false,
      message: 'Erro interno ao processar acesso'
    });
  }
});

/**
 * GET /api/autorizacao/status
 * Verifica se o endpoint de autorização está funcionando
 */
export const healthCheck = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    status: true,
    message: 'Autorização ONLINE',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/autorizacao/logs
 * Retorna os logs de acesso de um tenant (rota protegida)
 */
export const listarLogs = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 50, person_id, equipment_id, start_date, end_date, person_type, exclude_type, action, status } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  let query = 'SELECT * FROM access_log WHERE tenant_id = ?';
  let countQuery = 'SELECT COUNT(*) as total FROM access_log WHERE tenant_id = ?';
  const params = [req.tenantId];
  const countParams = [req.tenantId];

  if (person_id) {
    query += ' AND person_id = ?';
    countQuery += ' AND person_id = ?';
    params.push(person_id);
    countParams.push(person_id);
  }

  if (equipment_id) {
    query += ' AND equipment_id = ?';
    countQuery += ' AND equipment_id = ?';
    params.push(equipment_id);
    countParams.push(equipment_id);
  }

  if (person_type) {
    query += ' AND person_type = ?';
    countQuery += ' AND person_type = ?';
    params.push(person_type);
    countParams.push(person_type);
  }

  if (exclude_type) {
    query += ' AND person_type != ?';
    countQuery += ' AND person_type != ?';
    params.push(exclude_type);
    countParams.push(exclude_type);
  }

  if (action) {
    query += ' AND action = ?';
    countQuery += ' AND action = ?';
    params.push(action);
    countParams.push(action);
  }

  if (status) {
    query += ' AND status = ?';
    countQuery += ' AND status = ?';
    params.push(status);
    countParams.push(status);
  }

  if (start_date) {
    query += ' AND created_at >= ?';
    countQuery += ' AND created_at >= ?';
    params.push(start_date);
    countParams.push(start_date);
  }

  if (end_date) {
    query += ' AND created_at <= ?';
    countQuery += ' AND created_at <= ?';
    params.push(end_date);
    countParams.push(end_date);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const logs = await db.all(query, params);
  const { total } = await db.get(countQuery, countParams);

  // Buscar nomes relacionados
  for (const log of logs) {
    // Verificar na tabela de veículos
    const vehicle = await db.get(
      'SELECT plate, license_plate, model FROM vehicles WHERE id = ?',
      [log.person_id]
    );
    
    if (vehicle) {
      // É um veículo!
      log.person_type = 'vehicle';
      log.person_name = vehicle.plate || vehicle.license_plate || 'Veículo';
      log.vehicle_info = vehicle;
    } else if (log.person_type === 'person' || !log.person_type) {
      // Se não é veículo, buscar em persons
      const person = await db.get(
        'SELECT name FROM persons WHERE id = ?',
        [log.person_id]
      );
      if (person) {
        log.person_name = person.name;
      } else {
        // Buscar em visitors
        const visitor = await db.get(
          'SELECT name FROM visitors WHERE id = ?',
          [log.person_id]
        );
        if (visitor) {
          log.person_name = visitor.name;
        }
      }
    }

    const equip = await db.get('SELECT name FROM equipments WHERE id = ?', [log.equipment_id]);
    if (equip) {
      log.equipment_name = equip.name;
    }
  }

  res.status(200).json({
    success: true,
    data: logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total.total,
      totalPages: Math.ceil(total.total / parseInt(limit))
    }
  });
});

/**
 * POST /api/autorizacao/invalidate-cache
 * Invalida o cache de um tenant
 */
export const invalidateCacheEndpoint = asyncHandler(async (req, res) => {
  const { tenant_id } = req.body;
  
  if (!tenant_id) {
    return res.status(400).json({
      success: false,
      message: 'Parâmetro obrigatório: tenant_id'
    });
  }
  
  invalidateCache(tenant_id);
  
  res.status(200).json({
    success: true,
    message: `Cache invalidado para tenant: ${tenant_id}`
  });
});

/**
 * GET /api/autorizacao/debug-cache
 * Retorna informações de debug do cache
 */
export const debugCacheEndpoint = asyncHandler(async (req, res) => {
  const { tenant_id } = req.query;
  
  if (!tenant_id) {
    return res.status(400).json({
      success: false,
      message: 'Parâmetro obrigatório: tenant_id'
    });
  }
  
  const debugInfo = getCacheDebugInfo(tenant_id);
  
  res.status(200).json({
    success: true,
    data: debugInfo
  });
});

/**
 * POST /api/autorizacao/access/confirm
 * Confirmação de acesso para equipamentos IDBlock Next Facial
 * 
 * O fluxo funciona assim:
 * 1. Comunicador envia acesso -> API retorna status=true (acesso liberado)
 * 2. Equipamento processa e retorna validator, person_id, direction
 * 3. Comunicador envia confirmação com esses dados
 * 4. API registra o log de entrada ou saída
 * 
 * Parâmetros:
 * - tenant_id: ID do tenant
 * - equip_validator: Código do validador do equipamento
 * - person_id: ID da pessoa/visitante
 * - direction: 'left' ou 'right' (direção do acesso)
 */
export const confirmarAcesso = asyncHandler(async (req, res) => {
  const { tenant_id, equip_validator, person_id, direction, timestamp } = req.body;

  // Validação de parâmetros obrigatórios
  if (!tenant_id || !equip_validator || !person_id || !direction) {
    return res.status(400).json({
      success: false,
      status: false,
      message: 'Parâmetros obrigatórios: tenant_id, equip_validator, person_id, direction'
    });
  }

  // Validar direction (aceita left, right, giveup ou entry/exit para modo standalone)
  if (!['left', 'right', 'giveup', 'entry', 'exit'].includes(direction.toLowerCase())) {
    return res.status(400).json({
      success: false,
      status: false,
      message: 'Direction inválido. Deve ser "left", "right", "giveup", "entry" ou "exit"'
    });
  }

  try {
    if (VERBOSE_LOG) {
      logger.debug('[autorizacao/confirm] request', { tenant_id, equip_validator, person_id, direction });
    }

    const result = await confirmarAcessoDirection(tenant_id, equip_validator, person_id, direction.toLowerCase());

    if (VERBOSE_LOG) {
      logger.debug('[autorizacao/confirm] response', {
        tenant_id, equip_validator, person_id, direction,
        allowed: result.allowed, message: result.message
      });
    }

    return res.status(200).json({
      success: true,
      status: result.allowed,
      message: result.message,
      data: result.data
    });

  } catch (error) {
    logger.error('[autorizacao/confirm] erro', {
      tenant_id, equip_validator, person_id, direction,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      status: false,
      message: 'Erro interno ao processar confirmação de acesso'
    });
  }
});

/**
 * Autorizador Service - Sistema de Autorização de Acesso de Alta Performance
 * 
 * Otimizações implementadas:
 * 1. Cache em memória por tenant (regras, equipamentos, horários)
 * 2. Conexões persistentes (reutilização do pool)
 * 3. Consultas otimizadas com Índices
 * 4. Preparado para PostgreSQL (abstração)
 */

import dbManager from '../config/database.js';
import emailService from './emailService.js';
import { enqueueForActiveDevices } from './pushOutbox.js';
import { toDeviceUserId } from './deviceUserId.js';
import { participatesInParkingControl, isVehicleReader } from '../utils/equipmentType.js';

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

/**
 * Parse seguro de campo JSON do banco de dados
 */
function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || [];
    } catch (e) {
      return [];
    }
  }
  return value || [];
}

// ============================================
// CONFIGURAÇÃO DE CACHE
// ============================================

const CACHE_CONFIG = {
  // TTL em milliseconds (5 minutos para regras, 2 minutos para equipamentos)
  REGRAS_TTL: 5 * 60 * 1000,
  EQUIPAMENTOS_TTL: 2 * 60 * 1000,
  HORARIOS_TTL: 5 * 60 * 1000,
  CONFIG_TTL: 5 * 60 * 1000,
};

// Cache em memória por tenant
const cache = new Map();

// Estrutura do cache por tenant
class TenantCache {
  constructor() {
    this.regras = null;
    this.regrasTimestamp = 0;
    this.regrasVeiculos = null;
    this.regrasVeiculosTimestamp = 0;
    this.equipamentos = new Map(); // key: validador, value: equipamento
    this.equipamentosTimestamp = 0;
    this.horarios = new Map(); // key: id, value: horario
    this.horariosTimestamp = 0;
    // Cache de system_config (autorizador_busca_id_primeiro etc) — não muda em runtime
    this.config = new Map(); // key: config_key, value: config_value
    this.configTimestamp = 0;
  }

  isExpired(timestamp, ttl) {
    return Date.now() - timestamp > ttl;
  }
}

/**
 * Lê uma chave de system_config com cache em memória.
 * Evita 1 query no banco por requisição de acesso.
 */
async function getSystemConfig(db, tenantId, key) {
  const tc = getTenantCache(tenantId);
  if (!tc.isExpired(tc.configTimestamp, CACHE_CONFIG.CONFIG_TTL) && tc.config.has(key)) {
    return tc.config.get(key);
  }
  const row = await db.get(
    'SELECT config_value FROM system_config WHERE config_key = ?',
    [key]
  );
  const value = row?.config_value ?? null;
  tc.config.set(key, value);
  tc.configTimestamp = Date.now();
  return value;
}

// Obter cache por tenant
function getTenantCache(tenantId) {
  if (!cache.has(tenantId)) {
    cache.set(tenantId, new TenantCache());
  }
  return cache.get(tenantId);
}

// ============================================
// CONSULTAS OTIMIZADAS (Preparado para PostgreSQL)
// ============================================

// Queries otimizadas com JOINs minimizados para SQLite
const QUERIES = {
  // Buscar equipamento por validador (usa índice)
  EQUIPAMENTO_POR_VALIDADOR: `
    SELECT id, name, validador, tipo, modelo, equipamento_saida, controla_estacionamento, active, direction_entrada, direction_saida, inativar_visitante 
    FROM equipments 
    WHERE validador = ? AND active = 1
    LIMIT 1
  `,

  // Buscar pessoa por ID (usa índice)
  PESSOA_POR_ID: `
    SELECT id, name, status, group_id, company_id, registration_number 
    FROM persons 
    WHERE id = ?
    LIMIT 1
  `,

  // Buscar visitante por ID (usa índice)
  VISITANTE_POR_ID: `
    SELECT id, name, status, registration_number, entry_date, exit_date, liberation_type, period_start, period_end, expected_exit_date, prevent_auto_exit
    FROM visitors 
    WHERE id = ?
    LIMIT 1
  `,

  // Buscar regras ativas (usa índice) - o filtro por tenant é aplicado em buscarRegras
  REGRAS_ATIVAS: `
    SELECT id, tenant_id, name, access_type, persons, companies, groups, equipments, schedule_type, schedules, active
    FROM access_rules 
    WHERE active = 1 AND tenant_id = ?
  `,

  // Buscar horário por ID (usa índice)
  // OBS: Os dias da semana estão na tabela schedule_ranges, não em schedules
  HORARIO_POR_ID: `
    SELECT s.id, s.name, s.type, s.description
    FROM schedules s
    WHERE s.id = ?
    LIMIT 1
  `,

  // Buscar ranges de um horário (dias da semana e horários)
  HORARIO_RANGES: `
    SELECT day_of_week, start_time, end_time
    FROM schedule_ranges
    WHERE schedule_id = ?
  `,

  // Buscar veículo ativo por pessoa (usa índice)
  VEICULO_POR_PESSOA: `
    SELECT id, plate, model, color, status 
    FROM vehicles 
    WHERE person_id = ? AND status = 'active'
    LIMIT 1
  `,
};

// ============================================
// AUTORIZADOR SERVICE
// ============================================

/**
 * Processa um acesso de forma otimizada
 * IMPORTANTE: a camada de comunicação envia SEMPRE a matrícula (registration_number)
 * no campo user_id, tanto para pessoas quanto para visitantes.
 * Aqui fazemos o mapeamento para o id interno (persons.id / visitors.id).
 * 
 * @param {string} tenantId - ID do tenant
 * @param {string} equipValidator - Código do validador do equipamento
 * @param {string|number} userId - Identificador vindo do equipamento (matrícula)
 * @param {string} personType - 'person' ou 'visitor' (opcional - será detectado automaticamente se não informado)
 * @returns {Promise<{allowed: boolean, message: string, data?: object}>}
 */
export async function processarAcesso(tenantId, equipValidator, userId, personType, options = {}) {
  const startTime = Date.now();
  
  try {
    // 1. Obter conexão do pool (reutilizada)
    const db = await dbManager.getConnection(tenantId);

    // 2. Configuração de ordem de busca (com cache, evita query por request)
    const buscaIdPrimeiroValue = await getSystemConfig(db, tenantId, 'autorizador_busca_id_primeiro');
    const buscaIdPrimeiro = buscaIdPrimeiroValue === 'true';

    // userId pode ser matrícula (registration_number) ou ID interno.
    // OTIMIZAÇÃO: rodamos as 4 buscas possíveis em PARALELO via Promise.all.
    // Antes eram até 4 awaits sequenciais (~waterfall), agora é 1 round-trip paralelo.
    const rawIdentifier = String(userId).trim();
    const numericId = Number(userId);
    const isNumeric = !Number.isNaN(numericId);

    const lookups = await Promise.all([
      db.get('SELECT id FROM persons WHERE registration_number = ? LIMIT 1', [rawIdentifier]),
      db.get('SELECT id FROM visitors WHERE registration_number = ? LIMIT 1', [rawIdentifier]),
      isNumeric ? db.get('SELECT id FROM persons WHERE id = ? LIMIT 1', [numericId]) : Promise.resolve(null),
      isNumeric ? db.get('SELECT id FROM visitors WHERE id = ? LIMIT 1', [numericId]) : Promise.resolve(null),
    ]);
    const [personByReg, visitorByReg, personById, visitorById] = lookups;

    let internalId = null;
    let resolvedPersonType = personType;

    // HINT do equipamento: se equipamento_saida=1 ou inativar_visitante=1,
    // o equip foi configurado pra tratar SAÍDA DE VISITANTE. Em colisão de
    // matrícula (uma mesma matrícula em persons E visitors), priorizamos
    // visitor — caso contrário a saída do visitante nunca dispararia inativação.
    let equipPrefereVisitor = false;
    try {
      const eq = await db.get(
        `SELECT equipamento_saida, inativar_visitante FROM equipments WHERE validador = ? LIMIT 1`,
        [equipValidator]
      );
      equipPrefereVisitor = !!eq && (eq.equipamento_saida === 1 || eq.inativar_visitante === 1);
    } catch {}

    // Aplicar a ordem de prioridade configurada sobre os resultados já buscados.
    // Se equipPrefereVisitor, visitor vence person quando ambos têm match.
    if (buscaIdPrimeiro) {
      // Prioridade: ID > matrícula
      if (equipPrefereVisitor && visitorById) {
        internalId = visitorById.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (personById) {
        internalId = personById.id;
        if (!resolvedPersonType) resolvedPersonType = 'person';
      } else if (visitorById) {
        internalId = visitorById.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (equipPrefereVisitor && visitorByReg) {
        internalId = visitorByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (personByReg) {
        internalId = personByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'person';
      } else if (visitorByReg) {
        internalId = visitorByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      }
    } else {
      // Prioridade padrão: matrícula > ID
      if (equipPrefereVisitor && visitorByReg) {
        internalId = visitorByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (personByReg) {
        internalId = personByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'person';
      } else if (visitorByReg) {
        internalId = visitorByReg.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (equipPrefereVisitor && visitorById) {
        internalId = visitorById.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      } else if (personById) {
        internalId = personById.id;
        if (!resolvedPersonType) resolvedPersonType = 'person';
      } else if (visitorById) {
        internalId = visitorById.id;
        if (!resolvedPersonType) resolvedPersonType = 'visitor';
      }
    }

    // 2.1. Se após o mapeamento ainda não temos um id interno, negar acesso
    if (!internalId) {
      const equipment = await buscarEquipamento(db, tenantId, equipValidator);
      if (equipment) {
        await registrarLog(db, tenantId, rawIdentifier, 'unknown', equipment.id, 'ENTRY', 'DENIED', 'Usuário não cadastrado (matrícula)');
      }
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Usuário não encontrado'
      };
    }

    // 2.2. Se personType não informado, detectar automaticamente usando o id interno
    if (!resolvedPersonType) {
      const person = await db.get('SELECT id FROM persons WHERE id = ?', [internalId]);
      const visitor = await db.get('SELECT id FROM visitors WHERE id = ?', [internalId]);
      
      if (visitor) {
        resolvedPersonType = 'visitor';
      } else if (person) {
        resolvedPersonType = 'person';
      } else {
        const equipment = await buscarEquipamento(db, tenantId, equipValidator);
        if (equipment) {
          await registrarLog(db, tenantId, internalId, 'unknown', equipment.id, 'ENTRY', 'DENIED', 'Usuário não cadastrado - ' + equipValidator);
        }
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Usuário não encontrado'
        };
      }
    }

    // 3. Buscar equipamento (com cache)
    const equipment = await buscarEquipamento(db, tenantId, equipValidator);
    if (!equipment) {
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Equipamento não encontrado'
      };
    }

    // 3.1. Verificar se o equipamento usa sistema de direção (IDBlock Next Facial)
    // Se tiver direction_entrada ou direction_saida configurados, não registra log aqui
    // O log será registrado apenas quando receber a confirmação de direção
    const usaDirecao = !!(equipment.direction_entrada || equipment.direction_saida);
    if (usaDirecao) {
    }

    // 4. Se equipamento de saída e visitante, verificar regras e inativar
    const isExitAction = equipment.equipamento_saida === 1;

    if (isExitAction && resolvedPersonType === 'visitor') {
      const realVisitorId = internalId;

      const visitor = await buscarUsuario(db, internalId, 'visitor');
      if (!visitor) {
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Visitante não encontrado'
        };
      }

      // Visitante já saiu
      if (visitor.status === 'exited') {
        await registrarLog(db, tenantId, realVisitorId, 'visitor', equipment.id, 'EXIT', 'DENIED', 'Visitante já saiu anteriormente');
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Visitante já saiu anteriormente',
          data: {
            visitor_id: realVisitorId,
            action: 'EXIT_ALREADY',
            reason: 'Visitor already exited'
          }
        };
      }

      // Verificar período do visitante (period_start a period_end)
      const periodoCheck = verificarPeriodoVisitante(visitor);
      if (!periodoCheck.allowed) {
        await registrarLog(db, tenantId, realVisitorId, 'visitor', equipment.id, 'EXIT', 'DENIED', periodoCheck.message);
        return periodoCheck;
      }

      // Verificar regras de acesso
      const regras = await buscarRegras(db, tenantId);
      const authResult = await verificarAutorizacao(db, tenantId, visitor, 'visitor', equipment, regras);

      if (!authResult.allowed) {
        await registrarLog(db, tenantId, realVisitorId, 'visitor', equipment.id, 'EXIT', 'DENIED', authResult.message);
        return authResult;
      }

      // prevent_auto_exit é exceção explícita (visitante com múltiplas entradas/saídas no dia)
      const preventAutoExit = visitor.prevent_auto_exit === 1 || visitor.prevent_auto_exit === true;

      if (!preventAutoExit) {
        // Regra de domínio: acesso de saída com sucesso SEMPRE inativa o visitante
        await db.run(
          'UPDATE visitors SET status = ?, exit_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['exited', realVisitorId]
        );

        // target_id = visitors.id interno (não a matrícula): o comunicador
        // grava o usuário no equipamento ControlID chaveado pelo id interno;
        // mandar matrícula aqui faz o destroy do _excluir_usuario_equipamento
        // não casar e o registro fica órfão.
        await db.run(
          `INSERT INTO access_tasks
           (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
           VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
          [tenantId, realVisitorId, `Exclusão de visitante por saída: ${visitor.name || realVisitorId}`]
        );

        // Push: enfileira destroy_objects em todos os equip push-enabled.
        // Independe do Comunicador legado. Best-effort: erro não bloqueia saída.
        try {
          const equipUserId = toDeviceUserId('visitor', realVisitorId, visitor.registration_number);
          await enqueueForActiveDevices(db, tenantId, async (deviceId) => [{
            deviceId,
            origin: `visitor:exit:${realVisitorId}`,
            endpoint: 'destroy_objects',
            body: { object: 'users', where: { users: { id: equipUserId } } },
          }]);
        } catch (pushErr) {
          console.error('[autorizador push exit visitor]', pushErr.message);
        }

        await registrarLog(db, tenantId, realVisitorId, 'visitor', equipment.id, 'EXIT', 'SUCCESS', 'Visitante inativado por saída');

        return {
          allowed: true,
          message: 'ACESSO REGISTRADO - Visitante saiu (inativado)',
          data: {
            visitor_id: visitor.registration_number || realVisitorId,
            action: 'EXIT'
          }
        };
      } else {
        // prevent_auto_exit ativo: registra saída mas mantém visitante ativo
        await registrarLog(db, tenantId, realVisitorId, 'visitor', equipment.id, 'EXIT', 'SUCCESS', 'Visitante saiu mas permanece ativo (prevent_auto_exit)');

        return {
          allowed: true,
          message: 'ACESSO REGISTRADO - Visitante saiu (permanece ativo)',
          data: {
            visitor_id: realVisitorId,
            action: 'EXIT_NO_INACTIVATE'
          }
        };
      }
    }

    // 4. Buscar usuário (já usando id interno)
    const user = await buscarUsuario(db, internalId, resolvedPersonType);
    if (!user) {
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Usuário não encontrado'
      };
    }

    // 5. Verificar status ativo
    // Para pessoas: status deve ser 'active'
    // Para visitantes: status deve ser 'on_premises' ou null (ainda não entrou)
    let statusValido = true;
    if (resolvedPersonType === 'visitor') {
      // Visitantes: permitem 'on_premises' ou null/vazio (ainda não entrou)
      // Se status for 'exited', verificar se tem período de liberação para reativar
      if (user.status === 'exited') {
        // Visitante saiu - verificar se tem prevent_auto_exit ativado E período válido
        const preventAutoExit = user.prevent_auto_exit === 1 || user.prevent_auto_exit === true;
        const periodoCheck = verificarPeriodoVisitante(user, true);
        
        // Só permite reativação automática se prevent_auto_exit = true E período válido
        if (preventAutoExit && periodoCheck.allowed) {
          // prevent_auto_exit está ativado e período válido - reativar automaticamente
          // Use ID directly - no subtraction
          await db.run(
            'UPDATE visitors SET status = ?, exit_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            ['on_premises', internalId]
          );
          // Atualizar o status do usuário em memória
          user.status = 'on_premises';
          await registrarLog(db, tenantId, internalId, 'visitor', equipment.id, 'ENTRY', 'SUCCESS', 'Visitante reativado automaticamente (prevenção de baixa ativada)');
        } else {
          statusValido = false;
        }
      } else if (user.status && user.status !== 'on_premises') {
        statusValido = false;
      }
    } else {
      // Pessoas: devem ter status 'active'
      if (user.status && user.status !== 'active') {
        statusValido = false;
      }
    }
    
    if (!statusValido) {
      await registrarLog(db, tenantId, internalId, resolvedPersonType, equipment.id, 'ENTRY', 'DENIED', 'Usuário inativo');
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Usuário inativo'
      };
    }

    // 6. Se visitante, verificar período de validade
    if (resolvedPersonType === 'visitor') {
      const periodoCheck = verificarPeriodoVisitante(user);
      if (!periodoCheck.allowed) {
        await registrarLog(db, tenantId, internalId, resolvedPersonType, equipment.id, 'ENTRY', 'DENIED', periodoCheck.message);
        return periodoCheck;
      }
    }

    // 7. Verificar regras de acesso (com cache)
    // Se equipamento controla estacionamento, usar regras de veículos
    let authResult;
    if (participatesInParkingControl(equipment)) {
      // Buscar veículos pela pessoa (userId agora é person_id)
      const vehicles = await buscarVeiculosPorPessoa(db, internalId);
      
      // Se não tem veículo cadastrado, continua com verificação de pessoa (pode acessar como pedestre)
      // Removida validação obrigatória de veículo - agora verifica grupos/empresas
      let vehicle = null;
      const isVehicleReaderEquipment = isVehicleReader(equipment);
      if (options.vehicleId) {
        // UHF: veículo pré-identificado pela tag — seleciona diretamente pelo id
        vehicle = vehicles.find(v => v.id === options.vehicleId) || vehicles[0];
      } else if (isVehicleReaderEquipment && userId && typeof userId === 'string') {
        // Equipamento de leitura veicular sem hint — tentar encontrar pela placa
        vehicle = vehicles.find(v =>
          v.plate && v.plate.toUpperCase() === userId.toUpperCase()
        ) || vehicles[0];
      } else {
        // Equipamento de pessoa — usar primeiro veículo
        vehicle = vehicles[0];
      }
      // Se não tem veículo válido, usa regras de pessoa (ANTES de acessar vehicle.status)
      if (!vehicle) {
        const regras = await buscarRegras(db, tenantId);
        authResult = await verificarAutorizacao(db, tenantId, user, resolvedPersonType, equipment, regras);
        
        if (usaDirecao && authResult.allowed) {
          return {
            allowed: true,
            message: 'ACESSO LIBERADO - Aguardando confirmação de direção',
            data: {
              person_id: internalId,
              person_type: resolvedPersonType,
              pending_direction: true
            }
          };
        }
        
        // Equipamento de estacionamento → sempre VEHICLE, independente de ter veículo vinculado
        // (acesso facial no cancela ainda é um evento de estacionamento)
        const controlaEstacionamento = participatesInParkingControl(equipment);
        const accessTypeLog = controlaEstacionamento ? 'VEHICLE' : 'PERSON';
        
        await registrarLog(
          db, 
          tenantId, 
          internalId, 
          resolvedPersonType, 
          equipment.id, 
          equipment.equipamento_saida === 1 ? 'EXIT' : 'ENTRY', 
          authResult.allowed ? 'SUCCESS' : 'DENIED',
          authResult.message,
          { accessType: accessTypeLog }
        );
        return authResult;
      }
      
      // Verificar status do veículo - aceitar 'active', 'inactive' ou null (primeiro acesso)
      // Veículos com status 'inactive' ou null podem acessar (primeiro acesso)
      if (vehicle.status && vehicle.status !== 'active' && vehicle.status !== 'inactive') {
        await registrarLog(
          db, 
          tenantId,
          vehicle.id, 
          'vehicle', 
          equipment.id, 
          equipment.equipamento_saida === 1 ? 'EXIT' : 'ENTRY', 
          'DENIED',
          'Veículo com status inválido',
          { vehicleId: vehicle.id, plate: vehicle.plate, companyId: vehicle.company_id, accessType: 'VEHICLE' }
        );
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Veículo com status inválido'
        };
      }
      
      // ============================================
      // Verificar se é equipamento de saída
      const isExit = equipment.equipamento_saida === 1;
      
      // ============================================
      // Verificar se o veículo já está no estacionamento (para entrada)
      // Se o veículo já está ativo, só permite entrada se for equipamento de saída
      // ============================================
      if (vehicle.status === 'active' && !isExit) {
        // Veículo já está dentro - verificar se é saída
        if (equipment.equipamento_saida !== 1) {
          await registrarLog(
            db, 
            tenantId,
            vehicle.id, 
            'vehicle', 
            equipment.id, 
            'ENTRY', 
            'DENIED',
            'Veículo já está no estacionamento',
            { vehicleId: vehicle.id, plate: vehicle.plate, companyId: vehicle.company_id, accessType: 'VEHICLE' }
          );
          return {
            allowed: false,
            message: 'ACESSO NEGADO - Veículo já está no estacionamento. Utilize o equipamento de saída.'
          };
        }
      }
      
      // Buscar regras de veículos
      const regrasVeiculos = await buscarRegrasVeiculos(db, tenantId);
      // Verificar se é equipamento de saída
      // (já declarado acima)
      
      // Executar validação completa de veículo
      authResult = await verificarAutorizacaoVeiculoCompleta(
        db, 
        tenantId, 
        vehicle, 
        internalId,
        resolvedPersonType,
        equipment, 
        regrasVeiculos,
        isExit,
        vehicles // Passar todos os veículos para lógica de múltiplos veículos
      );
      // Para veículos com sistema de direção, não registra log aqui
      if (usaDirecao && authResult.allowed) {
        return {
          allowed: true,
          message: 'ACESSO LIBERADO - Aguardando confirmação de direção',
          data: {
            person_id: vehicle.id,
            person_type: 'vehicle',
            vehicle_plate: vehicle.plate,
            pending_direction: true
          }
        };
      }
      
      // Registrar log de acesso para veículo
      // Usar license_plate como fallback se plate for null
      const vehiclePlate = vehicle.plate || vehicle.license_plate;
      await registrarLog(
        db,
        tenantId,
        vehicle.id,
        'vehicle',
        equipment.id,
        isExit ? 'EXIT' : 'ENTRY',
        authResult.allowed ? 'SUCCESS' : 'DENIED',
        authResult.message,
        { vehicleId: vehicle.id, plate: vehiclePlate, companyId: vehicle.company_id, accessType: 'VEHICLE', uhfTag: options.uhfTag || null, source: options.source || 'manual' }
      );
      
      // Se permitido, atualizar status do veículo
      if (authResult.allowed) {
        // Verificar se o equipamento controla estacionamento antes de mexer no status
        const equipamentoControlaEstacionamento = participatesInParkingControl(equipment);

        
        // Verificar se foi selecionado um veículo diferente (múltiplos veículos)
        const vehicleToUpdate = authResult.vehicle_id ? authResult.vehicle_id : vehicle.id;
        
        // Obter o parking_id da regra para setar no veículo
        const ruleParkingIdForVehicle = authResult.ruleParkingId || vehicle.parking_id;
        
        try {
          if (isExit) {
            // Saída - remover do estacionamento APENAS se o equipamento controla estacionamento
            if (equipamentoControlaEstacionamento) {
              await db.run(
                'UPDATE vehicles SET status = ?, parking_id = NULL WHERE id = ?',
                ['inactive', vehicleToUpdate]
              );
            } else {
            }
            
            // ============================================
            // Atualizar status de presença da pessoa (saída)
            // ============================================
            if (resolvedPersonType === 'person') {
              // Verificar se a pessoa ainda tem outros veículos no estacionamento
              const otherVehiclesInParking = await db.get(
                'SELECT COUNT(*) as count FROM vehicles WHERE person_id = ? AND status = ?',
                [internalId, 'active']
              );
              
              // Só marcar como exited se não tiver mais veículos ativos
              if (!otherVehiclesInParking || otherVehiclesInParking.count === 0) {
                await db.run(
                  'UPDATE persons SET on_premisse = 0, exited = 1 WHERE id = ?',
                  [internalId]
                );
              } else {
              }
            }
          } else {
            // Entrada - adicionar ao estacionamento APENAS se o equipamento controla estacionamento
            if (equipamentoControlaEstacionamento) {
              // Usar o parking_id da regra (não do veículo, que pode ser null para rotativos)
              const parkingIdToSet = ruleParkingIdForVehicle || vehicle.parking_id;
              await db.run(
                'UPDATE vehicles SET status = ?, parking_id = ? WHERE id = ?',
                ['active', parkingIdToSet, vehicleToUpdate]
              );
              // ============================================
              // Atualizar status de presença da pessoa
              // ============================================
              if (resolvedPersonType === 'person') {
                await db.run(
                  'UPDATE persons SET on_premisse = 1, exited = 0 WHERE id = ?',
                  [internalId]
                );
              }
            } else {
            }
          }
        } catch (e) {
          // Continua mesmo se der erro
        }

        // Um acesso = um veículo (loop multi-veículo removido)
      }
    } else {
      // Comportamento normal - usar regras de pessoas
      const regras = await buscarRegras(db, tenantId);
      authResult = await verificarAutorizacao(db, tenantId, user, resolvedPersonType, equipment, regras);

      // Registrar log de acesso (apenas se não usa sistema de direção)
      const logPersonId = internalId;
      
      if (usaDirecao) {
        // Para equipamentos com direção, não registra log aqui
        // O log será registrado quando vier a confirmação de direction
        // Retornar mensagem especial indicando que precisa de confirmação
        return {
          allowed: true,
          message: 'ACESSO LIBERADO - Aguardando confirmação de direção',
          data: {
            person_id: logPersonId,
            person_type: resolvedPersonType,
            pending_direction: true
          }
        };
      }
      
      await registrarLog(
        db, 
        tenantId, 
        logPersonId, 
        resolvedPersonType, 
        equipment.id, 
        equipment.equipamento_saida === 1 ? 'EXIT' : 'ENTRY', 
        authResult.allowed ? 'SUCCESS' : 'DENIED',
        authResult.message,
        { accessType: 'PERSON' }
      );
    }

    // Log de performance (debug)
    const duration = Date.now() - startTime;
    if (duration > 100) {
    }

    return authResult;

  } catch (error) {
    console.error('[AUTORIZADOR] Erro ao processar acesso:', error);
    // Por segurança, bloquear em caso de erro
    return {
      allowed: false,
      message: 'ACESSO BLOQUEADO (erro interno: ' + error.message + ')'
    };
  }
}

/**
 * Busca equipamento com cache
 */
async function buscarEquipamento(db, tenantId, validador) {
  const tenantCache = getTenantCache(tenantId);
  const validadorStr = String(validador);
  
  // Verificar cache - only return cached if the SPECIFIC validator exists
  if (!tenantCache.isExpired(tenantCache.equipamentosTimestamp, CACHE_CONFIG.EQUIPAMENTOS_TTL)) {
    if (tenantCache.equipamentos.has(validadorStr)) {
      return tenantCache.equipamentos.get(validadorStr);
    }
    // Key not in cache - fall through to query DB
  }

  // Buscar do banco
  const equipment = await db.get(QUERIES.EQUIPAMENTO_POR_VALIDADOR, [validadorStr]);
  
  // Atualizar cache
  if (equipment) {
    tenantCache.equipamentos.set(validador, equipment);
    tenantCache.equipamentosTimestamp = Date.now();
  }

  return equipment || null;
}

/**
 * Busca usuário (pessoa ou visitante) com todos os grupos
 */
async function buscarUsuario(db, userId, personType) {
  const isVisitorByType = personType === 'visitor';
  const isVisitorById = !personType && userId >= 100000;

  // Disparar busca da entidade principal e dos grupos em paralelo.
  // Se a entidade não existir, descartamos o resultado dos grupos (custo baixo).
  if (isVisitorByType || isVisitorById) {
    const [visitor, gruposAdicionais] = await Promise.all([
      db.get(QUERIES.VISITANTE_POR_ID, [userId]),
      db.all('SELECT group_id FROM person_groups WHERE person_id = ?', [userId]),
    ]);
    if (visitor) {
      visitor.all_groups = (gruposAdicionais || []).map(g => g.group_id);
    }
    return visitor;
  }

  const [person, gruposAdicionais] = await Promise.all([
    db.get(QUERIES.PESSOA_POR_ID, [userId]),
    db.all('SELECT group_id FROM person_groups WHERE person_id = ?', [userId]),
  ]);
  if (person) {
    person.all_groups = (gruposAdicionais || []).map(g => g.group_id);
  }
  return person;
}

/**
 * Verifica período de validade do visitante
 */
function verificarPeriodoVisitante(visitor, isReactivation = false) {
  // Se é uma reativação (visitante que já saiu), verificar tipo de liberação
  if (isReactivation) {
    // Se é visita única, não permite reativação automática
    if (visitor.liberation_type === 'unica') {
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Visita única expirada. Procure a recepção para nova liberação.'
      };
    }
    // Se não tem período e não é visita única, permite reativação
    if (!visitor.period_start || !visitor.period_end) {
      return { allowed: true };
    }
  }
  
  // Se for visita única, não valida período (conforme solicitado pelo usuário)
  // VISITA UNICA = liberada até o primeiro uso (entrada/saída)
  if (visitor.liberation_type === 'unica') {
    return { allowed: true };
  }
  
  // Se não tem período, permite (pode ser acesso livre ou sem restrição)
  if (!visitor.period_start || !visitor.period_end) {
    return { allowed: true };
  }

  const now = new Date();
  const periodoStart = new Date(visitor.period_start);
  const periodoEnd = new Date(visitor.period_end);

  if (now < periodoStart) {
    return {
      allowed: false,
      message: 'ACESSO NEGADO - Período de acesso ainda não iniciado'
    };
  }

  if (now > periodoEnd) {
    return {
      allowed: false,
      message: 'ACESSO NEGADO - Período de acesso expirado'
    };
  }

  return { allowed: true };
}

/**
 * Busca regras com cache
 */
async function buscarRegras(db, tenantId) {
  const tenantCache = getTenantCache(tenantId);

  // Verificar cache
  if (!tenantCache.isExpired(tenantCache.regrasTimestamp, CACHE_CONFIG.REGRAS_TTL)) {
    return tenantCache.regras;
  }

  // Buscar do banco apenas regras deste tenant
  const regras = await db.all(QUERIES.REGRAS_ATIVAS, [tenantId]);

  // Parsear JSON fields e normalizar tipos (especialmente equipments → números)
  const parsedRegras = regras.map(regra => {
    const persons = regra.persons ? JSON.parse(regra.persons) : [];
    const companies = regra.companies ? JSON.parse(regra.companies) : [];
    const groups = regra.groups ? JSON.parse(regra.groups) : [];
    const equipmentsRaw = regra.equipments ? JSON.parse(regra.equipments) : [];
    const schedules = regra.schedules ? JSON.parse(regra.schedules) : [];

    // Normalizar equipments para array de números, ignorando valores inválidos
    const equipments = Array.isArray(equipmentsRaw)
      ? equipmentsRaw
          .map(e => {
            const n = Number(e);
            return Number.isNaN(n) ? null : n;
          })
          .filter(e => e !== null)
      : [];

    return {
      ...regra,
      persons,
      companies,
      groups,
      equipments,
      schedules,
    };
  });

  // Atualizar cache
  tenantCache.regras = parsedRegras;
  tenantCache.regrasTimestamp = Date.now();

  return parsedRegras;
}

/**
 * Verifica autorização do usuário
 * 
 * LÓGICA CORRETA:
 * 1. ETAPA 1 - Filtrar regras aplicáveis (tipo de público)
 * 2. ETAPA 2 - Validar equipamento (regra sem equipamentos = INVÁLIDA)
 * 3. ETAPA 3 - Validar horário
 * 4. Decisão final - Se pelo menos uma regra passar todas as etapas → LIBERADO
 */
async function verificarAutorizacao(db, tenantId, user, userType, equipment, regras) {
  // Se não tem regras, NEGAR acesso por segurança
  if (!regras || regras.length === 0) {
    await registrarLog(db, tenantId, user?.id || 'unknown', userType, equipment.id, 'ENTRY', 'DENIED', 'Nenhuma regra de acesso ativa configurada');
    return { allowed: false, message: 'ACESSO NEGADO - Nenhuma regra de acesso ativa' };
  }

  // Log de cada regra
  regras.forEach((regra, idx) => {
  });
  // Determinar grupos/empresas do usuário
  // Para pessoas: usar group_id + grupos adicionais da tabela person_groups
  // Para visitantes: não tem grupos ou empresas
  let userGroups = [];
  let userCompanies = [];
  
  if (userType !== 'visitor') {
    // É pessoa - pode ter grupos e empresas
    if (user.group_id) {
      userGroups.push(user.group_id);
    }
    if (user.all_groups && user.all_groups.length > 0) {
      userGroups.push(...user.all_groups);
    }
    if (user.company_id) {
      userCompanies.push(user.company_id);
    }
  }
  // Visitantes não têm grupos ou empresas
  
  const uniqueGroups = [...new Set(userGroups.filter(g => g))];
  const userId = user.id;

  // Tracking de regras que falharam em cada etapa
  let regrasAplicaveisPorGrupo = [];
  let regrasQueFalharamEquipamento = [];
  let regrasQueFalharamHorario = [];

  for (const regra of regras) {
    // ============================================
    // ETAPA 1 - Verificar se regra é aplicável ao usuário (tipo de público)
    // ============================================
    let regraAplicavel = false;
    let motivo = '';

    // Verificar tipo de acesso da regra
    const accessType = regra.access_type;
    if (accessType === 'todos') {
      // Regra para todos - aplicável
      regraAplicavel = true;
    } else if (accessType === 'pessoas-especificas') {
      // Regra para pessoas específicas - verificar se user.id está na lista
      if (regra.persons && regra.persons.includes(user?.id)) {
        regraAplicavel = true;
      }
    } else if (accessType === 'pessoas-geral') {
      // Regra para pessoas em geral - aplicável se user não é visitante
      if (userType !== 'visitor') {
        regraAplicavel = true;
      }
    } else if (accessType === 'visitantes-geral') {
      // Regra para visitantes em geral - aplicável se user é visitante
      if (userType === 'visitor') {
        regraAplicavel = true;
      }
    } else if (accessType === 'empresas') {
      // Regra para empresas - verificar se empresa do usuário está na lista
      if (regra.companies && regra.companies.length > 0) {
        const hasCompany = regra.companies.some(c => userCompanies.includes(c));
        if (hasCompany) {
          regraAplicavel = true;
        }
      }
    } else if (accessType === 'grupos') {
      // Regra para grupos - verificar se algum grupo do usuário está na lista
      // INTERSEÇÃO(user.groups, rule.groups) NÃO VAZIA
      if (regra.groups && regra.groups.length > 0) {
        // Converter ambos para string para comparação correta (grupos podem estar como número ou string)
        const userGroupsStr = uniqueGroups.map(g => String(g));
        const hasGroup = regra.groups.some(g => userGroupsStr.includes(String(g)));
        if (hasGroup) {
          regraAplicavel = true;
        }
      }
    }
    if (!regraAplicavel) {
      continue; // Regra não é aplicável a este usuário
    }

    // Regra aplicável por tipo de público
    regrasAplicaveisPorGrupo.push(regra);

    // ============================================
    // ETAPA 2 - Validar equipamento
    // IMPORTANTE: Regra sem equipamentos = INVÁLIDA (ignorar)
    // ============================================
    const temEquipamentos = regra.equipments && regra.equipments.length > 0;
    if (!temEquipamentos) {
      // Regra INVÁLIDA - não tem equipamentos selecionados
      regrasQueFalharamEquipamento.push(regra);
      continue;
    }

    // Verificar se o equipamento está na lista (comparando por ID numérico, tolerando string/number)
    const equipIds = Array.isArray(regra.equipments) ? regra.equipments : [];
    const equipMatch = equipIds.some(eid => Number(eid) === Number(equipment.id));
    if (!equipMatch) {
      // Equipamento não permitido nesta regra
      regrasQueFalharamEquipamento.push(regra);
      continue;
    }
    // ============================================
    // ETAPA 3 - Validar horário
    // ============================================
    const horarioPermitido = await verificarHorarioRegra(db, tenantId, regra.schedules, regra.schedule_type);
    if (!horarioPermitido) {
      regrasQueFalharamHorario.push(regra);
      continue;
    }

    // ============================================
    // REGRA APROVADA - Todas as etapas passaram
    // ============================================
    return { allowed: true, message: 'ACESSO LIBERADO - Regra: ' + regra.name };
  }

  // ============================================
  // NENHUMA REGRA PASSOU TODAS AS ETAPAS
  // ============================================
  // Se existiam regras aplicáveis mas falharam por equipamento
  if (regrasQueFalharamEquipamento.length > 0) {
    return { allowed: false, message: 'ACESSO NEGADO - Equipamento não permitido' };
  }

  // Se existiam regras aplicáveis mas falharam por horário
  if (regrasQueFalharamHorario.length > 0) {
    return { allowed: false, message: 'ACESSO NEGADO - Fora do horário permitido' };
  }

  // Se nenhuma regra era aplicável ao usuário
  return { allowed: false, message: 'ACESSO NEGADO - Nenhuma regra aplicável' };
}

/**
 * Verifica se o horário atual é permitido para a regra
 * @param {Object} db - Conexão do banco
 * @param {Array} scheduleIds - IDs dos horários
 * @param {String} scheduleType - Tipo de schedule ('livre' ou 'especifico')
 */
async function verificarHorarioRegra(db, tenantId, scheduleIds, scheduleType) {
  // Se schedule_type é 'livre', permite sempre (24/7)
  if (scheduleType === 'livre') {
    return true;
  }
  
  // Se não tem schedule_ids, permite (sem restrição)
  if (!scheduleIds || scheduleIds.length === 0) {
    return true;
  }

  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 8); // HH:MM:SS
  const dayOfWeek = now.getDay();

  for (const scheduleId of scheduleIds) {
    const schedule = await buscarHorario(db, tenantId, scheduleId);
    if (!schedule || !schedule.ranges || schedule.ranges.length === 0) continue;

    // Verificar cada range do horário
    for (const range of schedule.ranges) {
      // Verificar dia da semana
      if (range.day_of_week !== undefined) {
        if (range.day_of_week !== dayOfWeek) {
          continue;
        }
      }

      // Verificar horário
      if (range.start_time && range.end_time) {
        if (currentTime >= range.start_time && currentTime <= range.end_time) {
          return true;
        }
      } else if (!range.start_time && !range.end_time) {
        return true; // Livre o dia todo
      }
    }
  }

  return false;
}

/**
 * Busca horário com cache (inclui os ranges)
 */
async function buscarHorario(db, tenantId, scheduleId) {
  const tenantCache = getTenantCache(tenantId);
  
  // Verificar cache
  if (tenantCache.horarios.has(scheduleId)) {
    return tenantCache.horarios.get(scheduleId);
  }

  // Buscar schedule do banco
  const schedule = await db.get(QUERIES.HORARIO_POR_ID, [scheduleId]);
  
  if (schedule) {
    // Buscar os ranges do horário
    const ranges = await db.all(QUERIES.HORARIO_RANGES, [scheduleId]);
    schedule.ranges = ranges;
    
    // Atualizar cache
    tenantCache.horarios.set(scheduleId, schedule);
  }

  return schedule || null;
}

/**
 * Registra log de acesso
 * @param {Object} db - Conexão com o banco de dados
 * @param {string} tenantId - ID do tenant
 * @param {number} personId - ID da pessoa/veículo
 * @param {string} personType - Tipo: 'person', 'visitor', 'vehicle'
 * @param {number} equipmentId - ID do equipamento
 * @param {string} action - Ação: 'ENTRY', 'EXIT', 'DENIED'
 * @param {string} status - Status: 'SUCCESS', 'DENIED', 'ERROR'
 * @param {string} message - Mensagem do log
 * @param {Object} options - Opções adicionais
 * @param {number} options.vehicleId - ID do veículo (se for acesso de veículo)
 * @param {string} options.plate - Placa do veículo (se for acesso de veículo)
 * @param {number} options.companyId - ID da empresa
 * @param {string} options.accessType - Tipo de acesso: 'PERSON' ou 'VEHICLE'
 */
/**
 * Registra log de acesso em background (fire-and-forget).
 * NÃO bloqueia o caminho de resposta ao comunicador.
 *
 * Importante: a função permanece compatível com chamadas `await registrarLog(...)`,
 * mas a Promise resolve imediatamente — o trabalho real (INSERT no banco, busca de
 * dados de notificação, disparo de e-mails) acontece em background via setImmediate.
 *
 * Erros são capturados e logados internamente; nunca propagam para o handler.
 */
function registrarLog(db, tenantId, personId, personType, equipmentId, action, status, message, options = {}) {
  // Snapshot dos dados para o background — evita captar referências mutáveis
  const { vehicleId, plate, companyId, accessType, uhfTag, source } = options;
  const validPersonTypes = ['person', 'visitor', 'vehicle'];
  const finalPersonType = validPersonTypes.includes(personType) ? personType : 'person';
  const finalAccessType = accessType || (personType === 'vehicle' ? 'VEHICLE' : 'PERSON');
  const createdAtIso = new Date().toISOString();

  setImmediate(async () => {
    try {
      await db.run(
        `INSERT INTO access_log (tenant_id, person_id, person_type, equipment_id, action, status, message, created_at, vehicle_id, plate, company_id, access_type, uhf_tag, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, personId, finalPersonType, equipmentId, action, status, message, createdAtIso, vehicleId || null, plate || null, companyId || null, finalAccessType, uhfTag || null, source || 'manual']
      );

      // Notificação especializada para visitante (já era fire-and-forget)
      const isNotificacaoVisitante = (
        (action === 'ENTRY' || action === 'EXIT') &&
        (personType === 'visitor') &&
        (status === 'SUCCESS')
      );
      if (isNotificacaoVisitante) {
        emailService.dispararEmailVisitante({
          tenantId,
          log: {
            person_id: personId,
            visited_company_id: companyId || null,
            company_id: companyId || null,
            action,
            person_type: 'visitor',
            access_granted: true,
            created_at: createdAtIso
          }
        }).catch(err =>
          console.error('[NotifVisitante] Erro ao disparar email imediato: ' + err.message)
        );
      }

      // Notificações genéricas (acesso negado, entrada de pessoa/visitante)
      if (status === 'SUCCESS' || status === 'DENIED') {
        let tipoEvento = null;
        if (status === 'DENIED') {
          tipoEvento = 'acesso_negado';
        } else if (action === 'ENTRY') {
          tipoEvento = personType === 'visitor' ? 'visitante_entrada' : 'pessoa_entrada';
        }

        if (tipoEvento) {
          // Buscas de enriquecimento em paralelo
          const [person, equip] = await Promise.all([
            db.get(
              `SELECT name, email FROM ${personType === 'visitor' ? 'visitors' : 'persons'} WHERE id = ?`,
              [personId]
            ),
            db.get('SELECT name FROM equipments WHERE id = ?', [equipmentId]),
          ]);

          emailService.dispararNotificacao({
            tipoEvento,
            tenantId,
            dados: {
              personName: person?.name || personId,
              personDocument: plate || personId,
              equipmentName: equip?.name || equipmentId,
              action,
              message,
              dataHora: new Date().toLocaleString('pt-BR')
            },
            emailDestinatarioDinamico: person?.email
          });
        }
      }
    } catch (error) {
      console.error('[AUTORIZADOR] Erro ao registrar log (background):', error.message);
    }
  });
}

/**
 * Busca veículo pela placa
 */
async function buscarVeiculoPorPlaca(db, plate) {
  // Sempre buscar sem a coluna status para evitar erros
  const vehicle = await db.get(
    'SELECT id, plate, license_plate, model, color, person_id, company_id, parking_id FROM vehicles WHERE UPPER(plate) = UPPER(?) OR UPPER(license_plate) = UPPER(?) LIMIT 1',
    [plate, plate]
  );
  // Status será definido como 'inactive' por padrão
  if (vehicle) {
    vehicle.status = 'inactive';
  }
  return vehicle || null;
}

/**
 * Busca veículos vinculados a uma pessoa
 */
async function buscarVeiculosPorPessoa(db, personId) {
  // Sempre buscar sem a coluna status para evitar erros
  try {
    const vehicles = await db.all(
      'SELECT id, plate, license_plate, model, color, person_id, company_id, parking_id, status, uhf_tag FROM vehicles WHERE person_id = ? ORDER BY id ASC',
      [personId]
    );
    // Retornar status real do banco
    return vehicles || [];
  } catch (e) {
    console.error('[DEBUG] ERRO ao buscar veículos:', e.message);
    throw e;
  }
}

/**
 * Verificação completa de autorização de veículo
 * Segue o fluxo de validação:
 * 1. Grupos / Pessoa / Empresa
 * 2. Estacionamento
 * 3. Equipamento
 * 4. Horário
 * 5. Validação de Vagas (Rotativa ou Fixa)
 * 
 * Casos especiais:
 * - Múltiplos veículos com vagas fixas diferentes (exceto equipamentos de leitura veicular)
 */
async function verificarAutorizacaoVeiculoCompleta(db, tenantId, vehicle, personId, personType, equipment, regras, isExit, allVehicles = null) {
  // Se não tem regras, permitir acesso
  if (!regras || regras.length === 0) {
    return { allowed: true, message: 'ACESSO LIBERADO - Sem regras de veículos configuradas', ruleParkingId: null };
  }
  
  // Buscar dados da pessoa para validação de grupos/empresas
  let person = null;
  let personGroups = [];
  let personCompanies = [];
  
  if (personType === 'person') {
    person = await db.get('SELECT id, name, group_id, company_id FROM persons WHERE id = ?', [personId]);
    if (person) {
      if (person.group_id) {
        personGroups.push(person.group_id);
      }
      // Buscar grupos adicionais
      const gruposAdicionais = await db.all(
        'SELECT group_id FROM person_groups WHERE person_id = ?',
        [personId]
      );
      personGroups.push(...gruposAdicionais.map(g => g.group_id));
      
      if (person.company_id) {
        personCompanies.push(person.company_id);
      }
    }
  }
  // Determinar empresas e estacionamentos do veículo
  let vehicleCompanies = [];
  let vehicleParkingId = null;
  
  if (vehicle.company_id) {
    vehicleCompanies.push(vehicle.company_id);
  }
  if (vehicle.parking_id) {
    vehicleParkingId = vehicle.parking_id;
  }
  // Verificar se é equipamento de leitura veicular (TAG/UHF)
  const isVehicleReaderEquipment = isVehicleReader(equipment);
  // Se não for equipamento de leitura veicular e a pessoa tiver múltiplos veículos com vagas fixas,
  // verificar se outro veículo pode acessar
  let vehiclesToCheck = [vehicle];
  
  if (!isVehicleReaderEquipment && allVehicles && allVehicles.length > 1) {
    // Incluir todos os veículos para verificação
    vehiclesToCheck = allVehicles;
  }
  
  // Iterar sobre todas as regras de veículos
  for (const regra of regras) {
    // ============================================
    // ETAPA 1 - Verificar se regra é aplicável (Grupo/Pessoa/Empresa)
    // ============================================
    let regraAplicavel = false;
    let motivo = '';
    
    const accessType = regra.access_type || 'todos';
    
    if (accessType === 'todos' || accessType === 'pessoas-geral') {
      // Regra para todos - aplicável
      regraAplicavel = true;
      motivo = 'Regra para todos';
    } else if (accessType === 'pessoas-especificas') {
      // Regra para pessoas específicas
      const rulePersons = parseJsonField(regra.persons);
      if (rulePersons.includes(personId)) {
        regraAplicavel = true;
        motivo = 'Pessoa específica';
      }
    } else if (accessType === 'empresas') {
      // Regra para empresas - verificar se empresa da pessoa está na lista
      const ruleCompanies = parseJsonField(regra.companies);
      if (ruleCompanies.length > 0) {
        const hasCompany = ruleCompanies.some(c => personCompanies.includes(c) || vehicleCompanies.includes(c));
        if (hasCompany) {
          regraAplicavel = true;
          motivo = 'Empresa vinculada';
        }
      }
    } else if (accessType === 'grupos') {
      // Regra para grupos - verificar se algum grupo da pessoa está na lista
      const ruleGroups = parseJsonField(regra.groups);
      if (ruleGroups.length > 0) {
        const hasGroup = ruleGroups.some(g => personGroups.includes(g));
        if (hasGroup) {
          regraAplicavel = true;
          motivo = 'Grupo vinculado';
        }
      }
    }
    
    if (!regraAplicavel) {
      continue; // Regra não é aplicável a este veículo/pessoa
    }
    // ============================================
    // ETAPA 2 - Verificar Estacionamento
    // ============================================
    // Veículos rotativos (sem parking_id) podem acessar se:
    // - A regra não tem restrição de estacionamentos
    // - OU a regra é para "todos" (pessoas geral)
    // Veículos com parking_id fixo precisam ter o estacionamento na lista
    const ruleParkings = parseJsonField(regra.parkings);
    if (ruleParkings.length > 0) {
      let estacionamentoAutorizado = false;
      
      if (vehicleParkingId) {
        // Veículo com vaga fixa - verificar se o estacionamento está na lista
        const parkingIdStr = String(vehicleParkingId);
        estacionamentoAutorizado = ruleParkings.some(p => String(p) === parkingIdStr);
      } else {
        // Veículo rotativo (sem parking_id):
        // - Se a regra é para "todos", permitir
        // - Se tem empresas configuradas, verificar se a empresa do veículo está na lista
        if (accessType === 'todos' || accessType === 'pessoas-geral') {
          // Regra para todos - permitir veículos rotativos
          estacionamentoAutorizado = true;
        } else {
          // Parse vehicle_companies se for string JSON
          const ruleVehicleCompanies = parseJsonField(regra.vehicle_companies);
          
          if (ruleVehicleCompanies.length > 0) {
            // Verificar se a empresa do veículo está na lista
            estacionamentoAutorizado = ruleVehicleCompanies.some(c => vehicleCompanies.includes(c));
          } else {
            // Se não há restrição de empresas, verificar empresas da pessoa
            const ruleCompanies = parseJsonField(regra.companies);
            
            if (ruleCompanies.length > 0) {
              estacionamentoAutorizado = ruleCompanies.some(c => personCompanies.includes(c));
            } else {
              // Permite se for regra de grupos ou pessoas específicas
              estacionamentoAutorizado = true;
            }
          }
        }
      }
      
      if (!estacionamentoAutorizado) {
        continue; // Estacionamento não permitido nesta regra
      }
    }
    // ============================================
    // ETAPA 3 - Verificar Equipamento
    // ============================================
    // Parse equipment se for string JSON
    const ruleEquipments = parseJsonField(regra.equipments);
    if (ruleEquipments.length > 0) {
      // Verificar se o equipamento está na lista
      const equipMatch = ruleEquipments.some(eid => {
        const eidNum = Number(eid);
        const equipIdNum = Number(equipment.id);
        return eidNum === equipIdNum;
      });
      
      if (!equipMatch) {
        continue; // Equipamento não permitido nesta regra
      }
    }
    // ============================================
    // ETAPA 4 - Verificar Horário
    // ============================================
    const ruleSchedules = parseJsonField(regra.schedules);
    if (ruleSchedules.length > 0) {
      const horarioValido = await verificarHorarioRegra(db, tenantId, ruleSchedules, regra.schedule_type);
      if (!horarioValido) {
        continue; // Fora do horário
      }
    }
    // ============================================
    // ETAPA 5 - Validação de Vagas
    // ============================================
    // Obter parking_id da regra para usar na atualização do veículo
    const ruleParkingId = ruleParkings && ruleParkings.length > 0 ? ruleParkings[0] : null;
    // Obter parking_id da regra
    const ruleParkingIdForVagas = ruleParkingId;
    
    // Se tem controle de vagas habilitado (max_vehicles > 0), buscar total de vagas do estacionamento
    const maxVehiclesRule = typeof regra.max_vehicles === 'number' ? regra.max_vehicles : parseInt(regra.max_vehicles) || 0;
    
    // Só validar vagas para entrada (não para saída)
    // Verificar se há vagas disponíveis usando parking_id
    const parkingType = typeof regra.parking_type === 'string' ? regra.parking_type : (regra.parking_type || null);
    // Buscar informações do estacionamento (vagas totais e vagas por empresa)
    let parkingInfo = null;
    let vagasPorEmpresa = null;
    if (ruleParkingIdForVagas) {
      try {
        const parking = await db.get('SELECT total_spots, empresas FROM parkings WHERE id = ?', [ruleParkingIdForVagas]);
        if (parking) {
          parkingInfo = parking;
          if (parking.empresas) {
            try {
              vagasPorEmpresa = JSON.parse(parking.empresas);
            } catch (e) {}
          }
        }
      } catch (e) {
      }
    }
    
    // Determinar o limite de vagas:
    // 1. Se vagasPorEmpresa está configurado e a empresa tem vagas, usar esse limite
    // 2. Se vagasPorEmpresa está configurado mas a empresa NÃO está na lista = 0 vagas (bloqueado)
    // 3. Se não tem vagasPorEmpresa configurado, usar total_spots ou max_vehicles da regra
    let maxVehicles = 0;
    let empresaSemVagasAlocadas = false;
    const vehicleCompanyId = vehicle.company_id;

    if (maxVehiclesRule > 0) {
      if (vagasPorEmpresa && vagasPorEmpresa.length > 0 && vehicleCompanyId) {
        const empresaConfig = vagasPorEmpresa.find(e => e.empresaId === vehicleCompanyId);
        if (empresaConfig && empresaConfig.vagas > 0) {
          maxVehicles = empresaConfig.vagas;
        } else {
          // Empresa não tem vagas alocadas neste estacionamento = acesso negado
          empresaSemVagasAlocadas = true;
          maxVehicles = 0;
        }
      } else {
        // Sem distribuição por empresa: usar total_spots do estacionamento
        maxVehicles = parkingInfo?.total_spots || maxVehiclesRule;
      }
    }
    
    // Se tem controle de vagas (maxVehicles > 0), validar vagas
    // parkingType null ou undefined é tratado como rotativo
    const effectiveParkingType = parkingType || 'rotativo';
    // Verificar se o equipamento atual controla estacionamento
    const equipamentoControlaEstacionamento = participatesInParkingControl(equipment);
    // Bloquear imediatamente se empresa não tem vagas alocadas
    if (!isExit && empresaSemVagasAlocadas && equipamentoControlaEstacionamento) {
      await registrarLog(
        db, tenantId, vehicle.id, 'vehicle', equipment.id,
        'ENTRY', 'DENIED',
        'ACESSO NEGADO - Empresa sem vagas alocadas neste estacionamento'
      );
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Empresa sem vagas alocadas neste estacionamento'
      };
    }

    if (!isExit && maxVehicles > 0 && equipamentoControlaEstacionamento) {
      // Contagem de veículos com status 'on_parking' no estacionamento
      // Usar o parking_id da regra, não do veículo
      const parkingIdToCheck = ruleParkingIdForVagas || vehicleParkingId;
      
      let currentCount;
      try {
        if (vehicleCompanyId && vagasPorEmpresa) {
          // Contar veículos dessa empresa específicos no estacionamento
          const result = await db.get(
            'SELECT COUNT(*) as count FROM vehicles WHERE parking_id = ? AND company_id = ? AND status = ?',
            [parkingIdToCheck, vehicleCompanyId, 'active']
          );
          currentCount = result;
        } else if (parkingIdToCheck) {
          // Contar todos os veículos no estacionamento
          const result = await db.get(
            'SELECT COUNT(*) as count FROM vehicles WHERE parking_id = ? AND status = ?',
            [parkingIdToCheck, 'active']
          );
          currentCount = result;
        } else {
          // Se não tem parking_id na regra, conta todos os veículos com status active
          const result = await db.get(
            "SELECT COUNT(*) as count FROM vehicles WHERE status = 'active'"
          );
          currentCount = result;
        }
      } catch (e) {
        // Se der erro, assume 0 vagas ocupadas
        currentCount = { count: 0 };
      }
      if (currentCount.count >= maxVehicles) {
        // Registrar log de acesso negado
        await registrarLog(
          db,
          tenantId,
          vehicle.id,
          'vehicle',
          equipment.id,
          equipment.equipamento_saida === 1 ? 'EXIT' : 'ENTRY',
          'DENIED',
          `ACESSO NEGADO - Limite de vagas para esta empresa atingido (${maxVehicles})`
        );
        
        return {
          allowed: false,
          message: `ACESSO NEGADO - Limite de vagas para esta empresa atingido (${maxVehicles})`
        };
      }
    } else if (!isExit && effectiveParkingType === 'fixo' && vehicle.parking_id) {
      // Verificar se a vaga fixa já está ocupada (qualquer veículo com mesmo parking_id)
      let vagaOcupada;
      try {
        vagaOcupada = await db.get(
          'SELECT id, plate FROM vehicles WHERE parking_id = ? AND id != ?',
          [vehicle.parking_id, vehicle.id]
        );
      } catch (e) {
        // Se der erro, assume vaga livre
        vagaOcupada = null;
      }
      if (vagaOcupada) {
        // Se não for equipamento de leitura veicular e tiver múltiplos veículos,
        // tentar encontrar outra vaga disponível
        if (!isVehicleReaderEquipment && allVehicles && allVehicles.length > 1) {
          // Verificar se outro veículo tem vaga disponível
          for (const v of allVehicles) {
            if (v.id === vehicle.id) continue; // Pular o veículo atual
            
            if (v.parking_id) {
              let outraVagaOcupada;
              try {
                outraVagaOcupada = await db.get(
                  'SELECT id FROM vehicles WHERE parking_id = ? AND id != ?',
                  [v.parking_id, v.id]
                );
              } catch (e) {
                outraVagaOcupada = null;
              }
              
              if (!outraVagaOcupada) {
                // Encontrou vaga disponível
                return {
                  allowed: true,
                  message: `ACESSO LIBERADO - Regra: ${regra.name} (veículo ${v.plate})`,
                  rule: regra.name,
                  vehicle_id: v.id,
                  vehicle_plate: v.plate,
                  ruleParkingId: ruleParkingId
                };
              }
            }
          }
        }
        
        return {
          allowed: false,
          message: `ACESSO NEGADO - Vaga fixa já ocupada pelo veículo ${vagaOcupada.plate}`
        };
      }
    }
    
    // ============================================
    // REGRA APROVADA - Todas as etapas passaram
    // ============================================
    return { 
      allowed: true, 
      message: `ACESSO LIBERADO - Regra: ${regra.name}`,
      rule: regra.name,
      ruleParkingId: ruleParkingId
    };
  }
  
  // ============================================
  // NENHUMA REGRA PASSOU TODAS AS ETAPAS
  // ============================================
  return { allowed: false, message: 'ACESSO NEGADO - Nenhuma regra de veículo aplicável' };
}

/**
 * Busca regras de acesso para veículos
 */
async function buscarRegrasVeiculos(db, tenantId) {
  const tenantCache = getTenantCache(tenantId);
  
  // Verificar cache
  if (!tenantCache.isExpired(tenantCache.regrasVeiculosTimestamp, CACHE_CONFIG.REGRAS_TTL)) {
    return tenantCache.regrasVeiculos || [];
  }
  // Verificar se a coluna access_target existe
  let colunas = await db.all("PRAGMA table_info(access_rules)");
  let temAccessTarget = colunas.some(c => c.name === 'access_target');
  
  let regras;
  if (temAccessTarget) {
    // Se a coluna existe, buscar regras com access_target = 'vehicles' ou rules sem access_target (legado)
    regras = await db.all(`
      SELECT * FROM access_rules 
      WHERE tenant_id = ? AND active = 1 
      AND (access_target = 'vehicles' OR access_target IS NULL OR access_target = '')
    `, [tenantId]);
  } else {
    // Se não existe, buscar todas as regras ativas (compatibilidade com sistema legado)
    regras = await db.all(`
      SELECT * FROM access_rules 
      WHERE tenant_id = ? AND active = 1
    `, [tenantId]);
  }
  // Parsear JSON fields e normalizar tipos
  const parsedRegras = regras.map(regra => {
    const persons = regra.persons ? JSON.parse(regra.persons) : [];
    const companies = regra.companies ? JSON.parse(regra.companies) : [];
    const groupsRaw = regra.groups ? JSON.parse(regra.groups) : [];
    const equipmentsRaw = regra.equipments ? JSON.parse(regra.equipments) : [];
    const schedules = regra.schedules ? JSON.parse(regra.schedules) : [];
    const vehicles = regra.vehicles ? JSON.parse(regra.vehicles) : [];
    const vehicle_companies = regra.vehicle_companies ? JSON.parse(regra.vehicle_companies) : [];
    const parkings = regra.parkings ? JSON.parse(regra.parkings) : [];

    // Normalizar groups para array de números
    const groups = Array.isArray(groupsRaw)
      ? groupsRaw
          .map(g => Number(g))
          .filter(g => !isNaN(g))
      : [];

    // Normalizar equipments para array de números
    const equipments = Array.isArray(equipmentsRaw)
      ? equipmentsRaw
          .map(e => Number(e))
          .filter(e => !isNaN(e))
      : [];

    return {
      ...regra,
      persons,
      companies,
      groups,
      equipments,
      schedules,
      vehicles,
      vehicle_companies,
      parkings
    };
  });
  
  // Atualizar cache
  tenantCache.regrasVeiculos = parsedRegras;
  tenantCache.regrasVeiculosTimestamp = Date.now();
  
  return parsedRegras;
}

/**
 * Verifica autorização de veículo
 */
async function verificarAutorizacaoVeiculo(db, tenantId, vehicle, equipment, regras) {
  // Se não tem regras, permitir
  if (!regras || regras.length === 0) {
    return { allowed: true, message: 'ACESSO LIBERADO - Sem regras de veículos', ruleParkingId: null };
  }
  
  // Determinar empresas e estacionamentos do veículo
  let vehicleCompanies = [];
  let vehicleParkingId = null;
  
  if (vehicle.company_id) {
    vehicleCompanies.push(vehicle.company_id);
  }
  if (vehicle.parking_id) {
    vehicleParkingId = vehicle.parking_id;
  }
  
  for (const regra of regras) {
    // ============================================
    // ETAPA 1 - Verificar se regra é aplicável ao veículo
    // ============================================
    let regraAplicavel = false;
    
    // Verificar veículos específicos
    if (regra.vehicles && regra.vehicles.length > 0) {
      if (regra.vehicles.includes(vehicle.id)) {
        regraAplicavel = true;
      }
    }
    
    // Verificar empresas de veículos
    if (!regraAplicavel && regra.vehicle_companies && regra.vehicle_companies.length > 0) {
      const hasCompany = regra.vehicle_companies.some(c => vehicleCompanies.includes(c));
      if (hasCompany) {
        regraAplicavel = true;
      }
    }
    
    // Verificar estacionamentos
    if (!regraAplicavel && regra.parkings && regra.parkings.length > 0) {
      if (regra.parkings.includes(vehicleParkingId)) {
        regraAplicavel = true;
      }
    }
    
    // Se regra não é aplicável, continuar para próxima
    if (!regraAplicavel) {
      continue;
    }
    
    // ============================================
    // ETAPA 2 - Verificar equipamentos da regra
    // ============================================
    let temEquipamento = false;
    if (!regra.equipments || regra.equipments.length === 0) {
      // Se não tem equipamentos específicos, aplica a todos
      temEquipamento = true;
    } else {
      temEquipamento = regra.equipments.includes(equipment.id);
    }
    
    if (!temEquipamento) {
      continue;
    }
    
    // ============================================
    // ETAPA 3 - Verificar horário da regra
    // ============================================
    if (regra.schedules && regra.schedules.length > 0) {
      const horarioValido = await verificarHorarioRegra(db, tenantId, regra.schedules, regra.schedule_type);
      if (!horarioValido) {
        continue;
      }
    }
    
    // ============================================
    // ETAPA 4 - Verificar vagas (controle de estacionamento)
    // ============================================
    // Parse parking_type e max_vehicles
    const parkingType2 = typeof regra.parking_type === 'string' ? regra.parking_type : (regra.parking_type || null);
    const maxVehicles2 = typeof regra.max_vehicles === 'number' ? regra.max_vehicles : parseInt(regra.max_vehicles) || 0;
    
    if (parkingType2 === 'rotativo' && maxVehicles2 > 0) {
      // Contar apenas veículos com status 'active' (dentro do estacionamento)
      const ruleVehicleCompanies2 = parseJsonField(regra.vehicle_companies);
      const currentCount = await db.get(
        `SELECT COUNT(*) as count FROM vehicles
         WHERE company_id IN (${ruleVehicleCompanies2.map(() => '?').join(',')})
         AND parking_id = ? AND status = 'active'`,
        [...ruleVehicleCompanies2, vehicleParkingId]
      );
      
      if (currentCount.count >= maxVehicles2) {
        // Registrar log de acesso negado
        await registrarLog(
          db,
          tenantId,
          vehicle.id,
          'vehicle',
          equipment.id,
          equipment.equipamento_saida === 1 ? 'EXIT' : 'ENTRY',
          'DENIED',
          `ACESSO NEGADO - Limite de vagas atingido (${maxVehicles2})`
        );
        
        return {
          allowed: false,
          message: `ACESSO NEGADO - Limite de vagas atingido (${maxVehicles2})`
        };
      }
    } else if (parkingType2 === 'fixo' && vehicle.parking_id) {
      // Verificar se a vaga fixa está ocupada por outro veículo ativo
      const vagaOcupada = await db.get(
        "SELECT id FROM vehicles WHERE parking_id = ? AND id != ? AND status = 'active'",
        [vehicle.parking_id, vehicle.id]
      );
      
      if (vagaOcupada) {
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Vaga já ocupada'
        };
      }
    }
    
    // Se passou em todas as verificações, liberar acesso
    return { 
      allowed: true, 
      message: 'ACESSO LIBERADO - Regra de veículo aplicável',
      ruleParkingId: ruleParkingId
    };
  }
  
  // Nenhuma regra aplicável encontrada
  return { allowed: false, message: 'ACESSO NEGADO - Nenhuma regra de veículo aplicável' };
}

/**
 * Invalida cache de um tenant
 * Chamado quando regras são alteradas
 */
export function invalidateCache(tenantId) {
  if (cache.has(tenantId)) {
    cache.delete(tenantId);
  }
}

/**
 * Invalida cache de equipamento específico
 */
export function invalidateEquipamentoCache(tenantId, validador) {
  const tenantCache = getTenantCache(tenantId);
  if (tenantCache.equipamentos.has(validador)) {
    tenantCache.equipamentos.delete(validador);
  }
}

/**
 * Retorna informações de debug do cache
 */
export function getCacheDebugInfo(tenantId) {
  const tenantCache = getTenantCache(tenantId);
  
  return {
    hasCache: cache.has(tenantId),
    regrasTimestamp: tenantCache.regrasTimestamp,
    regrasCount: tenantCache.regras ? tenantCache.regras.length : 0,
    equipamentosCount: tenantCache.equipamentos.size,
    horariosCount: tenantCache.horarios.size,
    regras: tenantCache.regras ? tenantCache.regras.map(r => ({
      id: r.id,
      name: r.name,
      access_type: r.access_type,
      groups: r.groups,
      equipments: r.equipments,
      schedule_type: r.schedule_type
    })) : []
  };
}

// ============================================
// MODELOS DE EQUIPAMENTO QUE USAM DIREÇÃO
// ============================================
// Equipamentos IDBlock Next, IDBlock Next Facial e IDBlock Facial
// usam direção (left/right) para determinar entrada/saída
const MODELOS_POR_DIRECAO = [
  'IDBlock Next',
  'IDBlock Next Facial',
  'IDBlock Facial',
  'IDBlock Next Facial' // Para compatibilidade
];

/**
 * Confirma acesso para equipamentos que usam direção
 * 
 * Para IDBlock Next, IDBlock Next Facial e IDBlock Facial:
 * - O fluxo normal retorna status=true (acesso liberado)
 * - Aguarda o comunicador retornar person_id e direction
 * - Com base na direção, determina se é entrada ou saída
 * - Se for saída e for visitante, inativa o visitante
 * 
 * @param {string} tenantId - ID do tenant
 * @param {string} equipValidator - Código do validador do equipamento
 * @param {number} personId - ID da pessoa/visitante
 * @param {string} direction - Direction retornado pelo equipamento ('left' ou 'right')
 * @returns {Promise<{allowed: boolean, message: string, data?: object}>}
 */
export async function confirmarAcessoDirection(tenantId, equipValidator, personId, direction) {
  const startTime = Date.now();
  
  try {
    const db = await dbManager.getConnection(tenantId);
    
    // 1. Buscar equipamento
    const equipment = await db.get(
      'SELECT id, name, tipo, modelo, direction_entrada, direction_saida, active, inativar_visitante, controla_estacionamento FROM equipments WHERE validador = ? AND active = 1 LIMIT 1',
      [equipValidator]
    );
    if (!equipment) {
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Equipamento não encontrado'
      };
    }
    
    // 2. Verificar se é um modelo que usa direção ou se tem direções configuradas
    // Aceita: modelos específicos OU equipamentos com direction_entrada/direction_saida configurados
    // OU modo standalone (direction = "entry" ou "exit")
    const directionLower = direction.toLowerCase();
    const isStandaloneDirection = directionLower === 'entry' || directionLower === 'exit';
    const temDirecoesConfiguradas = !!(equipment.direction_entrada || equipment.direction_saida);
    const modeloSuportado = MODELOS_POR_DIRECAO.includes(equipment.modelo);

    if (!modeloSuportado && !temDirecoesConfiguradas && !isStandaloneDirection) {
      return {
        allowed: false,
        message: 'ACESSO NEGADO - Equipamento não suporta confirmação por direção'
      };
    }

    // 3. Determinar se é entrada ou saída baseado na direção
    const isGiveup = directionLower === 'giveup';
    // "entry"/"exit" são usados pelo comunicador no modo standalone (sem catraca)
    const isEntrada = directionLower === 'entry' || directionLower === (equipment.direction_entrada || '').toLowerCase();
    const isSaida = directionLower === 'exit' || directionLower === (equipment.direction_saida || '').toLowerCase();

    // Se a direção não corresponde a nenhuma configuração e não é giveup, negar
    if (!isEntrada && !isSaida && !isGiveup) {
      // Registrar log de acesso negado
      await registrarLog(
        db,
        tenantId,
        personId,
        'unknown',
        equipment.id,
        'UNKNOWN',
        'DENIED',
        `Direção "${direction}" não configurada no equipamento`
      );
      
      return {
        allowed: false,
        message: `ACESSO NEGADO - Direção "${direction}" não configurada`
      };
    }
    
    const action = isEntrada ? 'ENTRY' : 'EXIT';

    // Detectar tipo de pessoa e ID real (suporte a matrícula)
    const rawIdentifier = String(personId).trim();
    let realPersonId = null;
    let personType = 'person';
    let userRecord = null;

    // Tentar encontrar por matrícula (persons)
    let found = await db.get('SELECT id, name, registration_number FROM persons WHERE registration_number = ?', [rawIdentifier]);
    if (found) {
      realPersonId = found.id;
      personType = 'person';
      userRecord = found;
    } else {
      // Tentar encontrar por matrícula (visitors)
      found = await db.get('SELECT id, name, registration_number FROM visitors WHERE registration_number = ?', [rawIdentifier]);
      if (found) {
        realPersonId = found.id;
        personType = 'visitor';
        userRecord = found;
      } else {
        // Tentar por ID direto (compatibilidade)
        const numericId = Number(personId);
        if (!Number.isNaN(numericId)) {
          // Pessoa?
          found = await db.get('SELECT id, name, registration_number FROM persons WHERE id = ?', [numericId]);
          if (found) {
            realPersonId = found.id;
            personType = 'person';
            userRecord = found;
          } else {
            // Visitante?
            found = await db.get('SELECT id, name, registration_number FROM visitors WHERE id = ?', [numericId]);
            if (found) {
              realPersonId = found.id;
              personType = 'visitor';
              userRecord = found;
            }
          }
        }
      }
    }

    // Se ainda não encontrou, negar (exceto se for giveup, onde registramos como unknown)
    if (!realPersonId) {
      if (isGiveup) {
        await registrarLog(db, tenantId, personId, 'unknown', equipment.id, 'DENIED', 'DENIED', 'DESISTENCIA DE ACESSO (Usuário desconhecido)');
        return { allowed: false, message: 'DESISTENCIA REGISTRADA (Usuário desconhecido)' };
      }

      await registrarLog(db, tenantId, personId, 'unknown', equipment.id, action, 'DENIED', 'Usuário não encontrado');
      return { allowed: false, message: 'ACESSO NEGADO - Usuário não encontrado' };
    }

    // Tratamento de giveup (desistência de acesso)
    if (isGiveup) {
      await registrarLog(db, tenantId, realPersonId, personType, equipment.id, 'DENIED', 'DENIED', 'DESISTENCIA DE ACESSO');
      return {
        allowed: false,
        message: 'DESISTENCIA REGISTRADA',
        data: { person_id: realPersonId, person_type: personType, action: 'GIVEUP' }
      };
    }
    
    // 5. Se for saída e for visitante, verificar e inativar
    if (isSaida && personType === 'visitor') {
      const shouldInactivate = equipment.inativar_visitante === 1;
      const visitor = await db.get(
        'SELECT id, registration_number, status, prevent_auto_exit FROM visitors WHERE id = ?',
        [realPersonId]
      );
      
      if (!visitor) {
        await registrarLog(
          db,
          tenantId,
          realPersonId,
          'visitor',
          equipment.id,
          action,
          'DENIED',
          'Visitante não encontrado'
        );
        
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Visitante não encontrado'
        };
      }
      
      // Verificar se o visitante já saiu
      if (visitor.status === 'exited') {
        await registrarLog(
          db,
          tenantId,
          realPersonId,
          'visitor',
          equipment.id,
          action,
          'DENIED',
          'Visitante já saiu anteriormente'
        );
        
        return {
          allowed: false,
          message: 'ACESSO NEGADO - Visitante já saiu anteriormente',
          data: {
            visitor_id: realPersonId,
            action: 'EXIT_ALREADY'
          }
        };
      }
      
      // Verificar prevent_auto_exit
      const preventAutoExit = visitor.prevent_auto_exit === 1 || visitor.prevent_auto_exit === true;
      
      if (!preventAutoExit && shouldInactivate) {
        // Inativar visitante
        await db.run(
          'UPDATE visitors SET status = ?, exit_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['exited', realPersonId]
        );
        
        // Criar tarefa de exclusão do visitante.
        // target_id = visitors.id interno (não matrícula): o comunicador
        // chaveia o usuário no equipamento ControlID por id interno; usar
        // matrícula aqui faz o destroy não casar e o registro fica órfão.
        await db.run(
          `INSERT INTO access_tasks
           (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
           VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
          [tenantId, realPersonId, `Exclusão de visitante por saída: ${visitor.name || realPersonId}`]
        );

        // Push: enfileira destroy_objects em todos os equip push-enabled.
        try {
          const equipUserId = toDeviceUserId('visitor', realPersonId, visitor.registration_number);
          await enqueueForActiveDevices(db, tenantId, async (deviceId) => [{
            deviceId,
            origin: `visitor:exit:${realPersonId}`,
            endpoint: 'destroy_objects',
            body: { object: 'users', where: { users: { id: equipUserId } } },
          }]);
        } catch (pushErr) {
          console.error('[autorizador push exit visitor (direction)]', pushErr.message);
        }

        // Registrar log (usar ID interno para joins corretos nos relatórios)
        await registrarLog(
          db,
          tenantId,
          realPersonId,
          'visitor',
          equipment.id,
          action,
          'SUCCESS',
          `Visitante inativado por saída (direção: ${direction})`
        );

        return {
          allowed: true,
          message: 'ACESSO REGISTRADO - Visitante saiu (inativado)',
          data: {
            person_id: visitor.registration_number || realPersonId,
            person_type: 'visitor',
            action: 'EXIT',
            direction: direction
          }
        };
      } else {
        // Não inativar - visitante permanece ativo
        await registrarLog(
          db,
          tenantId,
          realPersonId,
          'visitor',
          equipment.id,
          action,
          'SUCCESS',
          `Visitante saiu mas permanece ativo (prevenção de baixa) - direção: ${direction}`
        );
        
        return {
          allowed: true,
          message: 'ACESSO REGISTRADO - Visitante saiu (permanece ativo)',
          data: {
            person_id: realPersonId,
            person_type: 'visitor',
            action: 'EXIT_NO_INACTIVATE',
            direction: direction
          }
        };
      }
    }
    
    // 6. Registrar log — para estacionamento busca veículo vinculado à pessoa
    const controlaEstacionamento = participatesInParkingControl(equipment);

    if (controlaEstacionamento && personType === 'person') {
      // Buscar veículo ativo da pessoa
      const vehicle = await db.get(
        `SELECT v.id, v.plate, v.status, v.company_id
         FROM vehicles v
         WHERE v.person_id = ? AND v.status IN ('active','inactive')
         ORDER BY v.status = 'active' DESC, v.id ASC LIMIT 1`,
        [realPersonId]
      );

      if (vehicle) {
        // Atualizar status do veículo conforme direção
        const novoStatus = isEntrada ? 'active' : 'inactive';
        await db.run(
          'UPDATE vehicles SET status = ? WHERE id = ?',
          [novoStatus, vehicle.id]
        );

        await registrarLog(db, tenantId, realPersonId, 'vehicle', equipment.id, action, 'SUCCESS',
          isEntrada ? `Entrada de veículo registrada (placa: ${vehicle.plate})` : `Saída de veículo registrada (placa: ${vehicle.plate})`,
          { vehicleId: vehicle.id, plate: vehicle.plate, companyId: vehicle.company_id, accessType: 'VEHICLE' }
        );

        return {
          allowed: true,
          message: isEntrada ? 'ENTRADA REGISTRADA' : 'SAÍDA REGISTRADA',
          data: {
            person_id: (userRecord?.registration_number || realPersonId),
            person_type: 'vehicle',
            vehicle_id: vehicle.id,
            plate: vehicle.plate,
            owner_name: userRecord?.name || null,
            action,
            direction
          }
        };
      }
      // Sem veículo vinculado → registra como pessoa normal
    }

    await registrarLog(
      db,
      tenantId,
      realPersonId,
      personType,
      equipment.id,
      action,
      'SUCCESS',
      isEntrada ? `Entrada registrada (direção: ${direction})` : `Saída registrada (direção: ${direction})`
    );

    return {
      allowed: true,
      message: isEntrada ? 'ENTRADA REGISTRADA' : 'SAÍDA REGISTRADA',
      data: {
        person_id: (userRecord?.registration_number || realPersonId),
        person_type: personType,
        action: action,
        direction: direction
      }
    };
    
  } catch (error) {
    console.error('[AUTORIZADOR] Erro ao confirmar acesso:', error);
    return {
      allowed: false,
      message: 'ERRO INTERNO - ' + error.message
    };
  }
}

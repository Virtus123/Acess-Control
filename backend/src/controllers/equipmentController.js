import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';
import { randomUUID } from 'crypto';
import { invalidateCache } from '../services/autorizadorService.js';
import { notifyPushInvalidateCache } from '../services/pushOutbox.js';
import { isParkingEquipment } from '../utils/equipmentType.js';

// Listar todos os equipamentos com filtros
export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 50, search, tipo, active } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM equipments WHERE 1=1';
  const params = [];

  // Filtro por status ativo
  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  // Filtro por tipo
  if (tipo) {
    query += ' AND tipo = ?';
    params.push(tipo);
  }

  // Filtro por busca (nome, marca, modelo, ip)
  if (search) {
    query += ' AND (name LIKE ? OR marca LIKE ? OR modelo LIKE ? OR ip_address LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const equipments = await db.all(query, params);

  const syncQueueRows = await db.all(
    "SELECT equip_validator, status FROM equip_sync_queue WHERE status IN ('pending', 'syncing')"
  );
  const syncStatusByValidator = new Map(syncQueueRows.map(row => [row.equip_validator, row.status]));

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  // Formatar dados para frontend
  const formattedEquipments = equipments.map(equip => ({
    id: equip.id,
    equipId: equip.equip_id,
    name: equip.name,
    marca: equip.marca,
    modelo: equip.modelo,
    ipAddress: equip.ip_address,
    port: equip.port,
    tipo: equip.tipo,
    validador: equip.validador,
    usuario: equip.usuario,
    senha: equip.senha,
    serial: equip.serial,
    controlaEstacionamento: equip.controla_estacionamento === 1,
    equipamentoSaida: equip.equipamento_saida === 1,
    localizacao: equip.localizacao,
    descricao: equip.descricao,
    status: equip.status,
    online: equip.online === 1,
    lastConnection: equip.last_connection,
    createdAt: equip.created_at,
    updatedAt: equip.updated_at,
    active: equip.active === 1,
    direction_entrada: equip.direction_entrada,
    direction_saida: equip.direction_saida,
    inativarVisitante: equip.inativar_visitante === 1,
    syncStatus: syncStatusByValidator.get(equip.validador) || null,
    syncPending: syncStatusByValidator.has(equip.validador)
  }));

  res.json({
    success: true,
    data: formattedEquipments,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Buscar equipamento por ID
export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const equip = await db.get('SELECT * FROM equipments WHERE id = ?', [id]);

  if (!equip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  const syncRow = await db.get(
    "SELECT status FROM equip_sync_queue WHERE equip_validator = ? AND status IN ('pending','syncing') ORDER BY created_at ASC LIMIT 1",
    [equip.validador]
  );

  res.json({
    success: true,
    data: {
      id: equip.id,
      equipId: equip.equip_id,
      name: equip.name,
      marca: equip.marca,
      modelo: equip.modelo,
      ipAddress: equip.ip_address,
      port: equip.port,
      tipo: equip.tipo,
      validador: equip.validador,
      usuario: equip.usuario,
      senha: equip.senha,
      serial: equip.serial,
      controlaEstacionamento: equip.controla_estacionamento === 1,
      equipamentoSaida: equip.equipamento_saida === 1,
      localizacao: equip.localizacao,
      descricao: equip.descricao,
      status: equip.status,
      online: equip.online === 1,
      lastConnection: equip.last_connection,
      createdAt: equip.created_at,
      updatedAt: equip.updated_at,
      active: equip.active === 1,
      direction_entrada: equip.direction_entrada,
      direction_saida: equip.direction_saida,
      inativarVisitante: equip.inativar_visitante === 1,
      syncStatus: syncRow ? syncRow.status : null,
      syncPending: !!syncRow
    }
  });
});

// Buscar equipamento por equip_id (usado pelo comunicador)
export const getByEquipId = asyncHandler(async (req, res) => {
  const db = req.db;
  const { equipId } = req.params;

  const equip = await db.get('SELECT * FROM equipments WHERE equip_id = ?', [equipId]);

  if (!equip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  const syncRow = await db.get(
    "SELECT status FROM equip_sync_queue WHERE equip_validator = ? AND status IN ('pending','syncing') ORDER BY created_at ASC LIMIT 1",
    [equip.validador]
  );

  res.json({
    success: true,
    data: {
      id: equip.id,
      equipId: equip.equip_id,
      name: equip.name,
      marca: equip.marca,
      modelo: equip.modelo,
      ipAddress: equip.ip_address,
      port: equip.port,
      tipo: equip.tipo,
      validador: equip.validador,
      usuario: equip.usuario,
      senha: equip.senha,
      serial: equip.serial,
      controlaEstacionamento: equip.controla_estacionamento === 1,
      equipamentoSaida: equip.equipamento_saida === 1,
      localizacao: equip.localizacao,
      descricao: equip.descricao,
      status: equip.status,
      online: equip.online === 1,
      lastConnection: equip.last_connection,
      active: equip.active === 1,
      direction_entrada: equip.direction_entrada,
      direction_saida: equip.direction_saida,
      inativarVisitante: equip.inativar_visitante === 1,
      syncStatus: syncRow ? syncRow.status : null,
      syncPending: !!syncRow
    }
  });
});

// Criar novo equipamento
export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const { name, marca, modelo, ipAddress, port, tipo, validador, controlaEstacionamento, equipamentoSaida, localizacao, descricao, usuario, senha, serial, directionEntrada, directionSaida, inativarVisitante } = req.body;
  const tenantId = req.tenantId;
  const userId = req.user?.id;

  // Validar campos obrigatórios
  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Nome do equipamento é obrigatório'
    });
  }

  if (!tipo) {
    return res.status(400).json({
      success: false,
      message: 'Tipo do equipamento é obrigatório'
    });
  }

  // Mapear tipos do frontend para tipos do banco
  const tipoMap = {
    'facial': 'facial_entrada',
    'facial_entrada': 'facial_entrada',
    'facial_saida': 'facial_saida',
    'padrao': 'controle_acesso',
    'controle_acesso': 'controle_acesso',
    'henry': 'controle_acesso',
    'uhf': 'uhf',
    'tag': 'tag',
    'biometria': 'biometria',
    'cartao': 'cartao',
    'qrcode': 'qrcode',
    'outro': 'outro'
  };

  const tipoDB = tipoMap[tipo] || 'outro';

  const querControlar = controlaEstacionamento === true || controlaEstacionamento === 1;
  const podeControlar = isParkingEquipment({ tipo: tipoDB, modelo });
  const controlaEstacionamentoSeguro = (querControlar && podeControlar) ? 1 : 0;

  // Gerar equip_id único
  const equipId = `${tenantId}_${randomUUID().substring(0, 8).toUpperCase()}`;

  const query = `
    INSERT INTO equipments (
      tenant_id, equip_id, name, marca, modelo, ip_address, port, tipo, 
      validador, controla_estacionamento, equipamento_saida, localizacao, descricao, status, active, created_by,
      usuario, senha, serial, direction_entrada, direction_saida, inativar_visitante
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const result = await db.run(query, [
    tenantId,
    equipId,
    name,
    marca || null,
    modelo || null,
    ipAddress || null,
    port || 8080,
    tipoDB,
    validador || ipAddress || null,
    controlaEstacionamentoSeguro,
    equipamentoSaida === true || equipamentoSaida === 1 ? 1 : 0,
    localizacao || null,
    descricao || null,
    'active',
    1,
    userId || null,
    usuario || null,
    senha || null,
    serial || null,
    directionEntrada || null,
    directionSaida || null,
    inativarVisitante === true || inativarVisitante === 1 ? 1 : 0
  ]);

  res.status(201).json({
    success: true,
    message: 'Equipamento criado com sucesso',
    data: {
      id: result.lastInsertRowid,
      equipId: equipId
    }
  });
});

// Atualizar equipamento
export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, marca, modelo, ipAddress, port, tipo, validador, controlaEstacionamento, equipamentoSaida, localizacao, descricao, status, active, usuario, senha, serial, directionEntrada, directionSaida, inativarVisitante } = req.body;
  const tenantId = req.tenantId;

  // Verificar se equipamento existe
  const existingEquip = await db.get('SELECT * FROM equipments WHERE id = ?', [id]);

  if (!existingEquip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  // Mapear tipos do frontend para tipos do banco
  const tipoMap = {
    'facial': 'facial_entrada',
    'facial_entrada': 'facial_entrada',
    'facial_saida': 'facial_saida',
    'padrao': 'controle_acesso',
    'controle_acesso': 'controle_acesso',
    'henry': 'controle_acesso',
    'uhf': 'uhf',
    'tag': 'tag',
    'biometria': 'biometria',
    'cartao': 'cartao',
    'qrcode': 'qrcode',
    'outro': 'outro'
  };

  const tipoDB = tipo && tipo !== existingEquip.tipo ? (tipoMap[tipo] || tipo) : existingEquip.tipo;

  const modeloFinal = modelo !== undefined ? modelo : existingEquip.modelo;
  const querControlar = controlaEstacionamento !== undefined
    ? (controlaEstacionamento === true || controlaEstacionamento === 1)
    : (existingEquip.controla_estacionamento === 1);
  const podeControlar = isParkingEquipment({ tipo: tipoDB, modelo: modeloFinal });
  const controlaEstacionamentoSeguro = (querControlar && podeControlar) ? 1 : 0;

  const query = `
    UPDATE equipments SET
      name = ?,
      marca = ?,
      modelo = ?,
      ip_address = ?,
      port = ?,
      tipo = ?,
      validador = ?,
      controla_estacionamento = ?,
      equipamento_saida = ?,
      localizacao = ?,
      descricao = ?,
      status = ?,
      active = ?,
      usuario = ?,
      senha = ?,
      serial = ?,
      direction_entrada = ?,
      direction_saida = ?,
      inativar_visitante = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  await db.run(query, [
    name || existingEquip.name,
    marca !== undefined ? marca : existingEquip.marca,
    modelo !== undefined ? modelo : existingEquip.modelo,
    ipAddress !== undefined ? ipAddress : existingEquip.ip_address,
    port !== undefined ? port : existingEquip.port,
    tipoDB,
    validador !== undefined ? validador : existingEquip.validador,
    controlaEstacionamentoSeguro,
    equipamentoSaida !== undefined ? (equipamentoSaida === true || equipamentoSaida === 1 ? 1 : 0) : existingEquip.equipamento_saida,
    localizacao !== undefined ? localizacao : existingEquip.localizacao,
    descricao !== undefined ? descricao : existingEquip.descricao,
    status !== undefined ? status : existingEquip.status,
    active !== undefined ? (active === true || active === 1 ? 1 : 0) : existingEquip.active,
    usuario !== undefined ? usuario : existingEquip.usuario,
    senha !== undefined ? senha : existingEquip.senha,
    serial !== undefined ? serial : existingEquip.serial,
    directionEntrada !== undefined ? directionEntrada : existingEquip.direction_entrada,
    directionSaida !== undefined ? directionSaida : existingEquip.direction_saida,
    inativarVisitante !== undefined ? (inativarVisitante === true || inativarVisitante === 1 ? 1 : 0) : existingEquip.inativar_visitante,
    id
  ]);

  // Invalidar cache de equipamentos (autorizador LOCAL deste processo)
  if (tenantId) {
    invalidateCache(tenantId);
    // E notifica o Push Service (outro processo, cache separado) pra invalidar também
    notifyPushInvalidateCache(tenantId, existingEquip.validador);
  }

  res.json({
    success: true,
    message: 'Equipamento atualizado com sucesso'
  });
});

// Excluir equipamento (hard delete)
export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Verificar se equipamento existe
  const existingEquip = await db.get('SELECT * FROM equipments WHERE id = ?', [id]);

  if (!existingEquip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  await db.run('DELETE FROM equipments WHERE id = ?', [id]);

  res.json({ success: true, message: 'Equipamento excluído com sucesso' });
  await auditService.logDelete(req, { entityType: 'equipment', entityId: id, description: `Equipamento excluído (ID: ${id})` });
});

// Inativar equipamento (soft delete)
export const inactivate = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Verificar se equipamento existe
  const existingEquip = await db.get('SELECT * FROM equipments WHERE id = ?', [id]);

  if (!existingEquip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  await db.run(
    'UPDATE equipments SET active = 0, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['inactive', id]
  );

  res.json({
    success: true,
    message: 'Equipamento inativado com sucesso'
  });
});

// Ativar equipamento
export const activate = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Verificar se equipamento existe
  const existingEquip = await db.get('SELECT * FROM equipments WHERE id = ?', [id]);

  if (!existingEquip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  await db.run(
    'UPDATE equipments SET active = 1, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['active', id]
  );

  res.json({
    success: true,
    message: 'Equipamento ativado com sucesso'
  });
});

// Atualizar status de conexão do equipamento (usado pelo comunicador)
export const updateConnectionStatus = asyncHandler(async (req, res) => {
  const db = req.db;
  const { equipId } = req.params;
  const { online } = req.body;

  const equip = await db.get('SELECT * FROM equipments WHERE equip_id = ?', [equipId]);

  if (!equip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado'
    });
  }

  await db.run(
    'UPDATE equipments SET online = ?, last_connection = CURRENT_TIMESTAMP WHERE equip_id = ?',
    [online === true || online === 1 ? 1 : 0, equipId]
  );

  res.json({
    success: true,
    message: 'Status de conexão atualizado'
  });
});

// Rota para o comunicador buscar dados do equipamento por validador
export const getByValidator = asyncHandler(async (req, res) => {
  const db = req.db;
  const { validador } = req.params;

  const equip = await db.get('SELECT * FROM equipments WHERE validador = ?', [validador]);

  if (!equip) {
    return res.status(404).json({
      success: false,
      message: 'Equipamento não encontrado pelo validador'
    });
  }

  res.json({
    success: true,
    data: {
      id: equip.id,
      equipId: equip.equip_id,
      name: equip.name,
      marca: equip.marca,
      modelo: equip.modelo,
      ipAddress: equip.ip_address,
      port: equip.port,
      tipo: equip.tipo,
      validador: equip.validador,
      usuario: equip.usuario,
      senha: equip.senha,
      serial: equip.serial,
      controlaEstacionamento: equip.controla_estacionamento === 1,
      equipamentoSaida: equip.equipamento_saida === 1,
      localizacao: equip.localizacao,
      descricao: equip.descricao,
      status: equip.status,
      online: equip.online === 1,
      active: equip.active === 1,
      inativarVisitante: equip.inativar_visitante === 1
    }
  });
});

// Listar equipamentos por tipo (para sincronização do comunicador)
export const listByType = asyncHandler(async (req, res) => {
  const db = req.db;
  const { tipo } = req.params;

  const equipments = await db.all(
    'SELECT * FROM equipments WHERE tipo = ? AND active = 1 ORDER BY name',
    [tipo]
  );

  const formattedEquipments = equipments.map(equip => ({
    id: equip.id,
    equipId: equip.equip_id,
    name: equip.name,
    marca: equip.marca,
    modelo: equip.modelo,
    ipAddress: equip.ip_address,
    port: equip.port,
    tipo: equip.tipo,
    validador: equip.validador,
    usuario: equip.usuario,
    senha: equip.senha,
    serial: equip.serial,
    controlaEstacionamento: equip.controla_estacionamento === 1,
    localizacao: equip.localizacao,
    status: equip.status,
    online: equip.online === 1
  }));

  res.json({
    success: true,
    data: formattedEquipments
  });
});

// Listar equipamentos que controlam estacionamento
export const listParkingEquipments = asyncHandler(async (req, res) => {
  const db = req.db;

  const equipments = await db.all(
    'SELECT * FROM equipments WHERE controla_estacionamento = 1 AND active = 1 ORDER BY name'
  );

  const formattedEquipments = equipments.map(equip => ({
    id: equip.id,
    equipId: equip.equip_id,
    name: equip.name,
    marca: equip.marca,
    modelo: equip.modelo,
    ipAddress: equip.ip_address,
    port: equip.port,
    tipo: equip.tipo,
    validador: equip.validador,
    usuario: equip.usuario,
    senha: equip.senha,
    serial: equip.serial,
    controlaEstacionamento: true,
    localizacao: equip.localizacao,
    status: equip.status,
    online: equip.online === 1
  }));

  res.json({
    success: true,
    data: formattedEquipments
  });
});

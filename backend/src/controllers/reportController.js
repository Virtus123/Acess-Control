import { asyncHandler } from '../middleware/errorHandler.js';
import { getPessoasNoLocal, getVeiculosNoLocal } from '../utils/statsHelper.js';

export const getDashboard = asyncHandler(async (req, res) => {
  const db = req.db;

  const today = new Date().toISOString().split('T')[0];

  const totalPersons = await db.get("SELECT COUNT(*) as count FROM persons WHERE status = 'active'");
  const groupsCount = await db.get("SELECT COUNT(*) as count FROM groups WHERE active = 1");
  const companiesCount = await db.get("SELECT COUNT(*) as count FROM companies WHERE active = 1");

  // Fonte de verdade única: access_log com status=SUCCESS
  const pessoasNoLocal = await getPessoasNoLocal(db, today);
  const visitorsOnPremises = pessoasNoLocal.filter(p => p.person_type === 'visitor' || p.person_type === 'visitante').length;
  const visitorsToday = await db.get(
    `SELECT COUNT(DISTINCT person_id) as count FROM access_log
     WHERE person_type = 'visitor' AND action = 'ENTRY' AND status = 'SUCCESS'
     AND DATE(created_at) = DATE('now')`
  );

  const recentActivity = await db.all(
    `SELECT
      'person_created' as type,
      name as name,
      created_at as time
     FROM persons
     WHERE created_at >= datetime('now', '-24 hours')
     UNION ALL
     SELECT
      'visitor_entry' as type,
      name as name,
      entry_date as time
     FROM visitors
     WHERE entry_date >= datetime('now', '-24 hours')
     ORDER BY time DESC
     LIMIT 10`
  );

  res.json({
    success: true,
    data: {
      total_persons: totalPersons.count,
      active_persons: totalPersons.count,
      total_visitors_today: visitorsToday?.count || 0,
      visitors_on_premises: visitorsOnPremises,
      groups_count: groupsCount.count,
      companies_count: companiesCount.count,
      recent_activity: recentActivity
    }
  });
});

export const createBackup = asyncHandler(async (req, res) => {
  const backupService = (await import('../services/backupService.js')).default;
  
  const backup = await backupService.createManualBackup(req.tenantId, req.user.id);
  
  res.status(201).json({
    success: true,
    data: backup,
    message: 'Backup criado com sucesso'
  });
});

export const getBackups = asyncHandler(async (req, res) => {
  const db = req.db;
  const { limit = 10 } = req.query;

  const backups = await db.all(
    'SELECT * FROM backups ORDER BY created_at DESC LIMIT ?',
    [parseInt(limit)]
  );

  res.json({
    success: true,
    data: backups
  });
});

// Relatório de Acessos
export const getAccessReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  
  const {
    startDate,
    endDate,
    direction,
    status,
    groupId,
    companyId,
    equipmentId,
    personId,
    personType
  } = req.query;

  let query = `
    SELECT
      al.id,
      al.created_at as dataHora,
      al.action as direcao,
      al.status as autorizacao,
      al.message,
      CASE
        WHEN al.person_type = 'person' THEN p.name
        WHEN al.person_type = 'visitor' THEN v.name
        WHEN al.person_type = 'vehicle' THEN pv.name
      END as nome,
      CASE
        WHEN al.person_type = 'person' THEN p.registration_number
        WHEN al.person_type = 'visitor' THEN v.document
        WHEN al.person_type = 'vehicle' THEN al.plate
      END as documento,
      CASE
        WHEN al.person_type = 'person' THEN p.registration_number
        WHEN al.person_type = 'vehicle' THEN pv.registration_number
        ELSE ''
      END as matricula,
      CASE
        WHEN al.person_type = 'person' THEN p.id
        WHEN al.person_type = 'visitor' THEN v.id
        WHEN al.person_type = 'vehicle' THEN al.vehicle_id
      END as pessoaId,
      al.person_type,
      al.access_type,
      e.name as equipamento,
      e.tipo as tipoEquipamento,
      g.name as grupo,
      COALESCE(cp.trading_name, cp.corporate_name, cv.trading_name, cv.corporate_name, '-') as empresa
    FROM access_log al
    LEFT JOIN persons p ON al.person_id = p.id AND al.person_type = 'person'
    LEFT JOIN visitors v ON al.person_id = v.id AND al.person_type = 'visitor'
    LEFT JOIN vehicles veh ON al.vehicle_id = veh.id
    LEFT JOIN persons pv ON veh.person_id = pv.id
    LEFT JOIN equipments e ON al.equipment_id = e.id
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN companies cp ON p.company_id = cp.id
    LEFT JOIN companies cv ON v.visited_company_id = cv.id
    WHERE al.tenant_id = ?
  `;

  const params = [tenantId];

  // Janela padrão: últimos 90 dias se nenhuma data foi informada.
  // Sem isso, o WHERE filtra apenas por tenant_id e a query fazia full scan da
  // access_log inteira (27k+ linhas em alguns tenants), resultando em queries
  // de 5-15s que travavam o frontend.
  let effectiveStartDate = startDate;
  if (!startDate && !endDate) {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    effectiveStartDate = d.toISOString();
  }

  if (effectiveStartDate) {
    query += ' AND al.created_at >= ?';
    params.push(effectiveStartDate);
  }

  if (endDate) {
    query += ' AND al.created_at <= ?';
    params.push(endDate);
  }

  if (direction) {
    query += ' AND al.action = ?';
    params.push(direction.toUpperCase());
  }

  if (status) {
    query += ' AND al.status = ?';
    params.push(status.toUpperCase());
  }

  if (groupId) {
    query += ' AND p.group_id = ?';
    params.push(parseInt(groupId));
  }

  if (companyId) {
    query += ' AND (p.company_id = ? OR v.visited_company_id = ? OR veh.company_id = ?)';
    params.push(parseInt(companyId), parseInt(companyId), parseInt(companyId));
  }

  if (equipmentId) {
    query += ' AND al.equipment_id = ?';
    params.push(parseInt(equipmentId));
  }

  if (personId) {
    query += ' AND al.person_id = ?';
    params.push(parseInt(personId));
  }

  if (personType) {
    if (personType === 'vehicle') {
      query += ' AND (al.access_type = \'VEHICLE\' OR e.controla_estacionamento = 1)';
    } else {
      query += ' AND al.person_type = ?';
      params.push(personType);
    }
  }

  query += ' ORDER BY al.created_at DESC';

  // Cap máximo de 10000 registros — antes o frontend mandava limit=100000 e o
  // navegador travava montando o DOM. 10k já é generoso para um relatório.
  const requestedLimit = parseInt(req.query.limit) || 1000;
  const limit = Math.min(requestedLimit, 10000);
  query += ' LIMIT ?';
  params.push(limit);

  const acessos = await db.all(query, params);

  // Converter campos para formato esperado pelo frontend
  const dados = acessos.map(acesso => ({
    id: acesso.id,
    nome: acesso.nome || '-',
    dataHora: acesso.dataHora,
    direcao: acesso.direcao ? acesso.direcao.toLowerCase() : '-',
    equipamento: acesso.equipamento || '-',
    empresa: acesso.empresa || '-',
    grupo: acesso.grupo || '-',
    autorizacao: acesso.autorizacao ? acesso.autorizacao.toLowerCase() : '-',
    matricula: acesso.matricula || '-',
    documento: acesso.documento || '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Acessos de Veículos
export const getAccessVehiclesReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  
  const {
    startDate,
    endDate,
    direction,
    status,
    companyId,
    equipmentId,
    parkingId,
    plate,
    model,
    brand,
    color,
    type,
    ownerId
  } = req.query;

  let query = `
    SELECT
      al.id,
      al.created_at as dataHora,
      al.action as direcao,
      al.status as autorizacao,
      al.message,
      COALESCE(al.vehicle_id, v2.id) as vehicleId,
      COALESCE(al.plate, v2.plate, v2.license_plate) as placa,
      COALESCE(v2.model, v3.model) as modelo,
      COALESCE(v2.color, v3.color) as cor,
      COALESCE(v2.brand, v3.brand) as marca,
      p.name as proprietario,
      p.registration_number as matricula,
      COALESCE(cv.trading_name, cv.corporate_name, cp.trading_name, cp.corporate_name, '-') as empresa,
      pk.name as estacionamento,
      al.equipment_id,
      e.name as equipamento,
      e.tipo as tipoEquipamento
    FROM access_log al
    LEFT JOIN vehicles v2 ON al.vehicle_id = v2.id
    LEFT JOIN vehicles v3 ON al.plate IS NOT NULL AND al.plate != '' AND v3.plate = al.plate
    LEFT JOIN persons p ON COALESCE(v2.person_id, v3.person_id, al.person_id) = p.id
    LEFT JOIN companies cv ON COALESCE(v2.company_id, v3.company_id) = cv.id
    LEFT JOIN companies cp ON p.company_id = cp.id
    LEFT JOIN parkings pk ON COALESCE(v2.parking_id, v3.parking_id) = pk.id
    LEFT JOIN equipments e ON al.equipment_id = e.id
    WHERE al.tenant_id = ?
      AND (al.access_type = 'VEHICLE' OR e.controla_estacionamento = 1)
  `;

  const params = [tenantId];

  if (startDate) {
    query += ' AND al.created_at >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND al.created_at <= ?';
    params.push(endDate);
  }

  if (direction) {
    query += ' AND al.action = ?';
    params.push(direction.toUpperCase());
  }

  if (status) {
    query += ' AND al.status = ?';
    params.push(status.toUpperCase());
  }

  if (companyId) {
    query += ' AND v.company_id = ?';
    params.push(parseInt(companyId));
  }

  if (equipmentId) {
    query += ' AND al.equipment_id = ?';
    params.push(parseInt(equipmentId));
  }

  if (parkingId) {
    query += ' AND v.parking_id = ?';
    params.push(parseInt(parkingId));
  }

  if (plate) {
    query += ' AND v.license_plate LIKE ?';
    params.push(`%${plate}%`);
  }

  if (model) {
    query += ' AND v.model LIKE ?';
    params.push(`%${model}%`);
  }

  if (brand) {
    query += ' AND v.brand LIKE ?';
    params.push(`%${brand}%`);
  }

  if (color) {
    query += ' AND v.color = ?';
    params.push(color);
  }

  if (type) {
    query += ' AND v.type = ?';
    params.push(type);
  }

  if (ownerId) {
    query += ' AND v.person_id = ?';
    params.push(parseInt(ownerId));
  }

  query += ' ORDER BY al.created_at DESC';

  // Cap máximo de 10000 — proteção contra limit gigante do front
  const requestedLimit = parseInt(req.query.limit) || 1000;
  const limit = Math.min(requestedLimit, 10000);
  query += ' LIMIT ?';
  params.push(limit);

  const acessos = await db.all(query, params);

  // Estatísticas
  const totalAcessos = acessos.length;
  const totalEntradas = acessos.filter(a => a.direcao === 'ENTRY').length;
  const totalSaidas = acessos.filter(a => a.direcao === 'EXIT').length;
  const totalNegados = acessos.filter(a => a.autorizacao === 'DENIED').length;
  
  // Veículos atualmente no estacionamento (status = active)
  const noEstacionamento = await db.get(
    "SELECT COUNT(*) as count FROM vehicles WHERE status = 'active'"
  );

  // Por empresa
  const porEmpresa = {};
  acessos.forEach(a => {
    const emp = a.empresa || 'Sem empresa';
    if (!porEmpresa[emp]) {
      porEmpresa[emp] = { total: 0, entradas: 0, saidas: 0 };
    }
    porEmpresa[emp].total++;
    if (a.direcao === 'ENTRY') porEmpresa[emp].entradas++;
    if (a.direcao === 'EXIT') porEmpresa[emp].saidas++;
  });

  const dados = acessos.map(acesso => ({
    id: acesso.id,
    dataHora: acesso.dataHora,
    direcao: acesso.direcao ? acesso.direcao.toLowerCase() : '-',
    autorizacao: acesso.autorizacao ? acesso.autorizacao.toLowerCase() : '-',
    message: acesso.message || '-',
    placa: acesso.placa || '-',
    modelo: acesso.modelo || '-',
    cor: acesso.cor || '-',
    marca: acesso.marca || '-',
    proprietario: acesso.proprietario || '-',
    matricula: acesso.matricula || '-',
    empresa: acesso.empresa || '-',
    estacionamento: acesso.estacionamento || '-',
    equipamento: acesso.equipamento || '-'
  }));

  res.json({
    success: true,
    data: dados,
    estatisticas: {
      totalAcessos,
      totalEntradas,
      totalSaidas,
      totalNegados,
      noEstacionamento: noEstacionamento.count,
      porEmpresa
    }
  });
});

function formatReportDateTime(value) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(value);
  }
}

function mapPersonStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'ativo' || s === '1' || s === 'true') return 'ATIVO';
  if (s === 'inactive' || s === 'inativo' || s === '0' || s === 'false') return 'INATIVO';
  return status ? String(status).toUpperCase() : '-';
}

// Relatório de Pessoas Cadastradas
export const getPersonsReport = asyncHandler(async (req, res) => {
  const db = req.db;

  const {
    status,
    active,
    groupId,
    groupName,
    companyId,
    search,
    startDate,
    endDate
  } = req.query;

  let query = `
    SELECT 
      p.id,
      p.name as nome,
      p.cpf,
      p.rg,
      p.registration_number as matricula,
      p.email,
      p.cellphone as telefone,
      p.profession as profissao,
      p.position as cargo,
      p.admission_date as dataAdmissao,
      p.status,
      p.created_at as dataCadastro,
      g.name as grupo,
      COALESCE(c.trading_name, c.corporate_name, '-') as empresa
    FROM persons p
    LEFT JOIN groups g ON p.group_id = g.id
    LEFT JOIN companies c ON p.company_id = c.id
    WHERE 1=1
  `;

  const params = [];

  if (active !== undefined && active !== '') {
    query += ' AND p.status = ?';
    params.push(active === 'true' ? 'active' : 'inactive');
  } else if (status) {
    const s = String(status).toUpperCase();
    if (s === 'ATIVO') {
      query += ' AND p.status = ?';
      params.push('active');
    } else if (s === 'INATIVO') {
      query += ' AND p.status = ?';
      params.push('inactive');
    } else {
      query += ' AND p.status = ?';
      params.push(status);
    }
  }

  if (groupId) {
    query += ' AND p.group_id = ?';
    params.push(parseInt(groupId, 10));
  }

  if (groupName) {
    query += ' AND g.name = ?';
    params.push(groupName);
  }

  if (companyId) {
    query += ' AND p.company_id = ?';
    params.push(parseInt(companyId, 10));
  }

  if (startDate) {
    query += ' AND DATE(p.created_at) >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND DATE(p.created_at) <= ?';
    params.push(endDate);
  }

  if (search) {
    query += ' AND (p.name LIKE ? OR p.cpf LIKE ? OR p.registration_number LIKE ? OR p.email LIKE ? OR c.trading_name LIKE ? OR c.corporate_name LIKE ? OR g.name LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY p.name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit, 10));

  const persons = await db.all(query, params);

  const dados = persons.map(p => ({
    ...p,
    status: mapPersonStatus(p.status),
    dataCadastro: formatReportDateTime(p.dataCadastro),
    dataAdmissao: p.dataAdmissao ? formatReportDateTime(p.dataAdmissao).split(' ')[0] : '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Visitantes Cadastrados
export const getVisitorsReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const {
    status,
    companyId,
    startDate,
    endDate,
    search
  } = req.query;

  let query = `
    SELECT 
      v.id,
      v.name as nome,
      v.document as cpf,
      v.rg,
      v.cellphone as telefone,
      v.email,
      v.visitor_company as empresa,
      v.reason as motivo,
      v.entry_date as dataEntrada,
      v.exit_date as dataSaida,
      v.status,
      v.created_at as dataCadastro,
      p.name as pessoaVisitada,
      COALESCE(c.trading_name, c.corporate_name, '-') as empresaVisitada
    FROM visitors v
    LEFT JOIN persons p ON v.visited_person_id = p.id
    LEFT JOIN companies c ON v.visited_company_id = c.id
    WHERE 1=1
  `;

  const params = [];

  if (req.query.active !== undefined && req.query.active !== '') {
    query += ' AND v.status = ?';
    params.push(req.query.active === 'true' ? 'active' : 'inactive');
  } else if (status) {
    const s = String(status).toUpperCase();
    if (s === 'ATIVO') {
      query += ' AND v.status = ?';
      params.push('active');
    } else if (s === 'INATIVO') {
      query += ' AND v.status = ?';
      params.push('inactive');
    } else {
      query += ' AND v.status = ?';
      params.push(status);
    }
  }

  if (companyId) {
    query += ' AND v.visited_company_id = ?';
    params.push(parseInt(companyId));
  }

  if (startDate) {
    query += ' AND v.entry_date >= ?';
    params.push(startDate);
  }

  if (endDate) {
    query += ' AND v.entry_date <= ?';
    params.push(endDate);
  }

  if (search) {
    query += ' AND (v.name LIKE ? OR v.document LIKE ? OR v.email LIKE ? OR v.visitor_company LIKE ? OR c.trading_name LIKE ? OR c.corporate_name LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY v.entry_date DESC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  const visitors = await db.all(query, params);

  const dados = visitors.map(v => ({
    ...v,
    status: mapPersonStatus(v.status),
    dataCadastro: formatReportDateTime(v.dataCadastro),
    dataEntrada: v.dataEntrada ? formatReportDateTime(v.dataEntrada) : '-',
    dataSaida: v.dataSaida ? formatReportDateTime(v.dataSaida) : '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Estatísticas para relatório de acessos
export const getAccessStats = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { startDate, endDate } = req.query;

  let dateFilter = '';
  const params = [tenantId];

  if (startDate && endDate) {
    dateFilter = ' AND al.created_at >= ? AND al.created_at <= ?';
    params.push(startDate, endDate);
  }

  // Total de acessos
  const totalAcessos = await db.get(
    `SELECT COUNT(*) as count FROM access_log al WHERE al.tenant_id = ?${dateFilter}`,
    params
  );

  // Total de entradas
  const totalEntradas = await db.get(
    `SELECT COUNT(*) as count FROM access_log al WHERE al.tenant_id = ? AND al.action = 'ENTRY'${dateFilter}`,
    params
  );

  // Total de saídas
  const totalSaidas = await db.get(
    `SELECT COUNT(*) as count FROM access_log al WHERE al.tenant_id = ? AND al.action = 'EXIT'${dateFilter}`,
    params
  );

  // Negados
  const totalNegados = await db.get(
    `SELECT COUNT(*) as count FROM access_log al WHERE al.tenant_id = ? AND al.status = 'DENIED'${dateFilter}`,
    params
  );

  // Contagem de empresas únicas com acessos
  const empresasAcesso = await db.get(
    `SELECT COUNT(DISTINCT c.id) as count 
     FROM access_log al 
     LEFT JOIN persons p ON al.person_id = p.id AND al.person_type = 'person'
     LEFT JOIN companies c ON p.company_id = c.id
     WHERE al.tenant_id = ?${dateFilter}`,
    params
  );

  // Pessoas presentes (entradas sem saída correspondente) - USANDO HELPER UNIFICADO
  const presentesHoje = await getPessoasNoLocal(db, endDate || new Date().toISOString().split('T')[0]);
  const countPresentes = presentesHoje.length;

  res.json({
    success: true,
    data: {
      total_acessos: totalAcessos.count,
      entradas: totalEntradas.count,
      saidas: totalSaidas.count,
      negados: totalNegados.count,
      empresas: empresasAcesso.count,
      presentes: countPresentes
    }
  });
});

// Obter listas para filtros
export const getReportFilters = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  // Grupos
  const groups = await db.all(
    'SELECT id, name FROM groups WHERE active = 1 ORDER BY name'
  );

  // Empresas
  const companies = await db.all(
    'SELECT id, trading_name, corporate_name FROM companies WHERE active = 1 ORDER BY trading_name'
  );

  // Equipamentos
  const equipments = await db.all(
    'SELECT id, name, tipo FROM equipments WHERE active = 1 ORDER BY name'
  );

  // Pessoas — limitado a 500 para não travar o Choices.js no front
  const persons = await db.all(
    'SELECT id, name, registration_number FROM persons WHERE status = ? ORDER BY name LIMIT 500',
    ['active']
  );

  // Visitantes — limitado a 500
  const visitors = await db.all(
    'SELECT id, name, document FROM visitors ORDER BY name LIMIT 500'
  );

  res.json({
    success: true,
    data: {
      groups,
      companies,
      equipments,
      persons,
      visitors
    }
  });
});

// Filtros para relatórios de veículos
export const getVehicleReportFilters = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  // Empresas
  const companies = await db.all(
    'SELECT id, trading_name, corporate_name FROM companies WHERE active = 1 ORDER BY trading_name'
  );

  // Equipamentos
  const equipments = await db.all(
    'SELECT id, name, tipo FROM equipments WHERE active = 1 ORDER BY name'
  );

  // Estacionamentos
  const parkings = await db.all(
    'SELECT id, name FROM parkings WHERE active = 1 ORDER BY name'
  );

  // Veículos
  const vehicles = await db.all(
    'SELECT id, license_plate, model, brand, color FROM vehicles WHERE status = ? ORDER BY license_plate LIMIT 500',
    ['active']
  );

  // Proprietários (pessoas com veículos)
  const owners = await db.all(
    `SELECT DISTINCT p.id, p.name 
     FROM persons p 
     JOIN vehicles v ON v.person_id = p.id 
     ORDER BY p.name LIMIT 500`
  );

  res.json({
    success: true,
    data: {
      companies,
      equipments,
      parkings,
      vehicles,
      owners
    }
  });
});

// Estatísticas de Acessos de Veículos
export const getVehicleAccessStats = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { startDate, endDate } = req.query;

  let dateFilter = '';
  const params = [tenantId];

  if (startDate && endDate) {
    dateFilter = ' AND al.created_at >= ? AND al.created_at <= ?';
    params.push(startDate, endDate);
  }

  // Total de acessos de veículos
  const totalAcessos = await db.get(
    `SELECT COUNT(*) as count FROM access_log al 
     WHERE al.tenant_id = ? AND al.person_type = 'vehicle'${dateFilter}`,
    params
  );

  // Total de entradas
  const totalEntradas = await db.get(
    `SELECT COUNT(*) as count FROM access_log al 
     WHERE al.tenant_id = ? AND al.person_type = 'vehicle' AND al.action = 'ENTRY' AND al.status = 'SUCCESS'${dateFilter}`,
    params
  );

  // Total de saídas
  const totalSaidas = await db.get(
    `SELECT COUNT(*) as count FROM access_log al 
     WHERE al.tenant_id = ? AND al.person_type = 'vehicle' AND al.action = 'EXIT' AND al.status = 'SUCCESS'${dateFilter}`,
    params
  );

  // Negados
  const totalNegados = await db.get(
    `SELECT COUNT(*) as count FROM access_log al 
     WHERE al.tenant_id = ? AND al.person_type = 'vehicle' AND al.status = 'DENIED'${dateFilter}`,
    params
  );

  // Veículos atualmente no local (entradas sem saída) - USANDO HELPER UNIFICADO
  const veiculosPresentes = await getVeiculosNoLocal(db, endDate || new Date().toISOString().split('T')[0]);
  const countVeiculosPresentes = veiculosPresentes.length;

  // Contagem de empresas únicas com acessos de veículos
  const empresasAcesso = await db.get(
    `SELECT COUNT(DISTINCT c.id) as count 
     FROM access_log al 
     JOIN vehicles v ON al.person_id = v.id AND al.person_type = 'vehicle'
     LEFT JOIN companies c ON v.company_id = c.id
     WHERE al.tenant_id = ?${dateFilter}`,
    params
  );

  res.json({
    success: true,
    data: {
      total_acessos: totalAcessos.count,
      entradas: totalEntradas.count,
      saidas: totalSaidas.count,
      negados: totalNegados.count,
      empresas: empresasAcesso.count,
      presentes: countVeiculosPresentes
    }
  });
});

// Relatório de Empresas
export const getCompaniesReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { active, search } = req.query;

  let query = `
    SELECT 
      c.id,
      c.corporate_name as nome,
      c.cnpj,
      c.phone as telefone,
      c.email,
      c.address as endereco,
      c.created_at as dataCriacao,
      c.active as status,
      (SELECT COUNT(*) FROM persons p WHERE p.company_id = c.id) as pessoasVinculadas
    FROM companies c
    WHERE 1=1
  `;

  const params = [];

  if (active !== undefined) {
    query += ' AND c.active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  if (search) {
    query += ' AND (c.corporate_name LIKE ? OR c.trading_name LIKE ? OR c.cnpj LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY c.corporate_name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  const companies = await db.all(query, params);

  // Formatar dados para o frontend
  const dados = companies.map(c => ({
    id: c.id,
    nome: c.nome || '-',
    cnpj: c.cnpj || '-',
    telefone: c.telefone || '-',
    email: c.email || '-',
    endereco: c.endereco || '-',
    dataCriacao: c.dataCriacao ? c.dataCriacao.split(' ')[0] : '-',
    status: c.status === 1 ? 'ATIVO' : 'INATIVO',
    pessoasVinculadas: c.pessoasVinculadas || 0
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Veículos
export const getVehiclesReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { search, companyId } = req.query;

  let query = `
    SELECT 
      v.id,
      v.license_plate as placa,
      v.brand as marca,
      v.model as modelo,
      v.color as cor,
      v.year as ano,
      p.name as pessoaVinculada,
      p.registration_number as matricula,
      COALESCE(cv.trading_name, cv.corporate_name, cp.trading_name, cp.corporate_name, '-') as empresa
    FROM vehicles v
    LEFT JOIN persons p ON v.person_id = p.id
    LEFT JOIN companies cp ON p.company_id = cp.id
    LEFT JOIN companies cv ON v.company_id = cv.id
    WHERE 1=1
  `;

  const params = [];

  if (search) {
    query += ' AND (v.license_plate LIKE ? OR p.name LIKE ? OR cv.trading_name LIKE ? OR cv.corporate_name LIKE ? OR cp.trading_name LIKE ? OR cp.corporate_name LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
  }

  if (companyId) {
    query += ' AND (v.company_id = ? OR p.company_id = ?)';
    params.push(parseInt(companyId), parseInt(companyId));
  }

  query += ' ORDER BY v.license_plate ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  console.log('[DEBUG] getVehiclesReport - query:', query);
  console.log('[DEBUG] getVehiclesReport - params:', params);
  const vehicles = await db.all(query, params);
  console.log('[DEBUG] getVehiclesReport - results:', vehicles.length);
  if (vehicles.length > 0) console.log('[DEBUG] Sample result:', JSON.stringify(vehicles[0]));

  const dados = vehicles.map(v => ({
    placa: v.placa || '-',
    marca: v.marca || '-',
    modelo: v.modelo || '-',
    cor: v.cor || '-',
    ano: v.ano || '-',
    pessoaVinculada: v.pessoaVinculada || '-',
    empresa: v.empresa || '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Estacionamentos
export const getParkingsReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { active } = req.query;

  let query = `
    SELECT 
      p.id,
      p.name as nome,
      p.total_spots as vagas,
      p.hourly_rate as valor,
      p.status,
      p.created_at as dataCriacao
    FROM parkings p
    WHERE p.tenant_id = ?
  `;

  const params = [tenantId];

  if (active !== undefined) {
    query += ' AND p.active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  query += ' ORDER BY p.name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  const parkings = await db.all(query, params);

  const dados = parkings.map(p => ({
    nome: p.nome || '-',
    vagas: p.vagas || 0,
    valor: p.valor || 0,
    tipo: p.vagas > 50 ? 'Grande' : (p.vagas > 20 ? 'Médio' : 'Pequeno'),
    status: p.status === 'active' ? 'ATIVO' : 'INATIVO'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Refeitório
export const getCafeteriasReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { tipo } = req.query;

  let query = `
    SELECT 
      c.id,
      c.name as refeitorio,
      c.location as localizacao,
      (SELECT COUNT(*) FROM cafeteria_access_rules car WHERE car.cafeteria_id = c.id) as regrasVinculadas
    FROM cafeterias c
    WHERE c.tenant_id = ?
  `;

  const params = [tenantId];

  query += ' ORDER BY c.name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  // Se não tiver dados, retornar mock
  const cafeterias = await db.all(query, params);

  if (cafeterias.length === 0) {
    // Retornar dados de exemplo
    res.json({
      success: true,
      data: [
        { refeitorio: 'Refeitório Principal', localizacao: 'Andar 1', regrasVinculadas: 3 },
        { refeitorio: 'Cafeteria', localizacao: 'Andar 2', regrasVinculadas: 2 }
      ]
    });
    return;
  }

  const dados = cafeterias.map(c => ({
    refeitorio: c.refeitorio || '-',
    localizacao: c.localizacao || '-',
    regrasVinculadas: c.regrasVinculadas || 0
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Horários
export const getSchedulesReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  let query = `
    SELECT 
      s.id,
      s.name as nome,
      s.time_start as horaInicio,
      s.time_end as horaFim,
      s.days as diasSemana,
      s.active as status
    FROM schedules s
    WHERE s.tenant_id = ?
  `;

  const params = [tenantId];

  query += ' ORDER BY s.name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  const schedules = await db.all(query, params);

  if (schedules.length === 0) {
    res.json({
      success: true,
      data: [
        { nome: 'COMERCIAL', horario: 'SEG A DOM - 00:00 AS 23:59', nivelVinculado: 'EDIFICIO' },
        { nome: 'CAFÉ DA MANHA', horario: 'SEG A SEX - 05:00 AS 10:00', nivelVinculado: 'CAFÉ DA MANHA' },
        { nome: 'ALMOÇO', horario: 'SEG A SEX - 11:30 AS 14:30', nivelVinculado: 'ALMOÇO' }
      ]
    });
    return;
  }

  const dados = schedules.map(s => ({
    nome: s.nome || '-',
    horario: `${s.diasSemana || 'SEG A DOM'} - ${s.horaInicio || '00:00'} AS ${s.horaFim || '23:59'}`,
    nivelVinculado: s.nome || '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});

// Relatório de Claviculário
export const getKeyholdersReport = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;

  const { status, groupId } = req.query;

  let query = `
    SELECT 
      kh.id,
      kh.name as claviculario,
      kh.location as localizacao,
      kh.status,
      p.name as pessoaVinculada,
      g.name as grupo
    FROM keyholders kh
    LEFT JOIN persons p ON kh.person_id = p.id
    LEFT JOIN groups g ON kh.group_id = g.id
    WHERE kh.tenant_id = ?
  `;

  const params = [tenantId];

  if (status) {
    query += ' AND kh.status = ?';
    params.push(status);
  }

  if (groupId) {
    query += ' AND kh.group_id = ?';
    params.push(parseInt(groupId));
  }

  query += ' ORDER BY kh.name ASC';

  const limit = req.query.limit || 5000;
  query += ' LIMIT ?';
  params.push(parseInt(limit));

  const keyholders = await db.all(query, params);

  if (keyholders.length === 0) {
    res.json({
      success: true,
      data: [
        { claviculario: 'ARMARIO 01', localizacao: 'Portaria', pessoaVinculada: '-', status: 'ATIVO', grupo: 'PORTARIA' },
        { claviculario: 'ARMARIO 02', localizacao: 'Recepção', pessoaVinculada: '-', status: 'ATIVO', grupo: 'RECEPÇÃO' }
      ]
    });
    return;
  }

  const dados = keyholders.map(kh => ({
    claviculario: kh.claviculario || '-',
    localizacao: kh.localizacao || '-',
    pessoaVinculada: kh.pessoaVinculada || '-',
    status: kh.status === 'active' ? 'ATIVO' : 'INATIVO',
    grupo: kh.grupo || '-'
  }));

  res.json({
    success: true,
    data: dados
  });
});




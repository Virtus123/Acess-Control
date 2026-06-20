import { formatVisitor, paginate } from '../utils/formatters.js';
import { validateCPF, validateEmail } from '../utils/validators.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { normalizeSearchTerm, buildAccentInsensitiveExpr } from '../utils/searchUtils.js';
import photoService from '../services/photoService.js';
import { extractEmbedding } from '../services/faceEmbeddingService.js';
import { generateRegistrationNumber } from '../utils/generators.js';
import { addToFaceQueue } from './faceQueueController.js';
import auditService from '../services/auditService.js';
import { enqueueForActiveDevices, enqueueForAuthorizedDevices, newBatchId } from '../services/pushOutbox.js';
import { toDeviceUserId } from '../services/deviceUserId.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

// === Push helpers (mesmo padrão do personController) ===
// PRODUÇÃO: id no equipamento = MATRÍCULA do visitante. Fallback (sem matrícula):
// visitors.id + OFFSET (1bi) — evita colisão com persons.id. Ver deviceUserId.js.
async function buildVisitorRegisterCommands({ visitor, tenantId, deviceId, photoBase64 }) {
  const batchId = newBatchId();
  const origin = `visitor:upsert:${visitor.id}`;
  const equipUserId = toDeviceUserId('visitor', visitor.id, visitor.registration_number);
  const cmds = [
    {
      deviceId, batchId, batchOrder: 0, origin,
      endpoint: 'create_or_modify_objects',
      body: {
        object: 'users',
        values: [{
          id: equipUserId,
          registration: visitor.registration_number || `${tenantId}_v${visitor.id}`,
          name: visitor.name || '',
        }],
      },
    },
    {
      deviceId, batchId, batchOrder: 1, origin,
      endpoint: 'create_or_modify_objects',
      body: {
        object: 'user_groups',
        values: [{ user_id: equipUserId, group_id: 1 }],
      },
    },
  ];
  if (photoBase64) {
    cmds.push({
      deviceId, batchId, batchOrder: 2, origin,
      endpoint: 'user_set_image',
      queryString: `user_id=${equipUserId}&timestamp=${Math.floor(Date.now()/1000)}&match=0`,
      body: photoBase64,
      contentType: 'application/octet-stream',
    });
  }
  return cmds;
}

async function loadPhotoBase64IfExists(photoUrl) {
  if (!photoUrl) return null;
  try {
    const relative = photoUrl.replace(/^\//, '');
    for (const p of [
      join(process.cwd(), 'public', relative),
      join(process.cwd(), 'uploads', relative),
      join(process.cwd(), relative),
    ]) {
      try { return (await readFile(p)).toString('base64'); } catch {}
    }
  } catch {}
  return null;
}

// Best-effort: nunca propaga erro (visitante já foi salvo na DB).
// Filtra por regras de acesso: equip só recebe visitante coberto por
// 'todos' ou 'visitantes-geral'. Se NÃO autorizado e visitante já estava
// no equip (status mudou, regra mudou), enfileira destroy.
async function enqueueVisitorUpsert(db, tenantId, visitor) {
  try {
    const photoBase64 = await loadPhotoBase64IfExists(visitor.photo_url);
    const equipUserId = toDeviceUserId('visitor', visitor.id, visitor.registration_number);
    await enqueueForAuthorizedDevices(db, tenantId, 'visitor', visitor.id, {
      onAuthorized: async (deviceId) => buildVisitorRegisterCommands({ visitor, tenantId, deviceId, photoBase64 }),
      onUnauthorized: async (deviceId) => [{
        deviceId,
        origin: `visitor:upsert:unauthorized:${visitor.id}`,
        endpoint: 'destroy_objects',
        body: { object: 'users', where: { users: { id: equipUserId } } },
      }],
    });
  } catch (err) {
    console.error('[push enqueue visitor upsert]', err.message);
  }
}

async function enqueueVisitorDelete(db, tenantId, visitorId, registrationNumber) {
  try {
    // Se vier sem matrícula, busca no banco (caso forceDelete já tenha removido a row,
    // o caller passa a matrícula explicitamente como argumento)
    let reg = registrationNumber;
    if (reg === undefined) {
      const row = await db.get('SELECT registration_number FROM visitors WHERE id = ?', [visitorId]);
      reg = row?.registration_number;
    }
    const equipUserId = toDeviceUserId('visitor', visitorId, reg);
    await enqueueForActiveDevices(db, tenantId, async (deviceId) => [{
      deviceId,
      origin: `visitor:delete:${visitorId}`,
      endpoint: 'destroy_objects',
      body: { object: 'users', where: { users: { id: equipUserId } } },
    }]);
  } catch (err) {
    console.error('[push enqueue visitor delete]', err.message);
  }
}

// Helper function to get table columns
async function getTableColumns(db, tableName) {
  try {
    const result = await db.all(`PRAGMA table_info(${tableName})`);
    return result.map(col => col.name);
  } catch (e) {
    console.error('Error getting table columns:', e);
    return [];
  }
}

// Helper function to ensure visitors table has required columns
async function ensureVisitorColumns(db) {
  try {
    const columns = await getTableColumns(db, 'visitors');
    
    // Array of columns to check and add if missing
    // This includes ALL columns from initial schema + migrations
    const columnsToAdd = [
      // Tenant column (for multi-tenant support)
      { name: 'tenant_id', type: 'TEXT' },
      // Basic columns from 001_initial
      { name: 'document', type: 'TEXT' },
      { name: 'rg', type: 'TEXT' },
      { name: 'cellphone', type: 'TEXT' },
      { name: 'email', type: 'TEXT' },
      { name: 'visitor_company', type: 'TEXT' },
      { name: 'visited_person_id', type: 'INTEGER' },
      { name: 'visited_company_id', type: 'INTEGER' },
      { name: 'reason', type: 'TEXT' },
      { name: 'entry_date', type: 'DATETIME' },
      { name: 'exit_date', type: 'DATETIME' },
      { name: 'photo_url', type: 'TEXT' },
      { name: 'status', type: "TEXT DEFAULT 'on_premises'" },
      { name: 'registered_by', type: 'INTEGER' },
      { name: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      // Additional columns
      { name: 'photo_base64', type: 'TEXT' },
      { name: 'card_number', type: 'TEXT' },
      { name: 'card_type', type: "TEXT DEFAULT 'manual'" },
      { name: 'face_embedding', type: 'TEXT' },
      { name: 'registration_number', type: 'TEXT' },
      { name: 'liberation_type', type: "TEXT DEFAULT 'unica'" },
      { name: 'period_start', type: 'DATETIME' },
      { name: 'period_end', type: 'DATETIME' },
      { name: 'expected_exit_date', type: 'DATETIME' },
      { name: 'prevent_auto_exit', type: 'INTEGER DEFAULT 0' },
      { name: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' }
    ];
    
    for (const col of columnsToAdd) {
      if (!columns.includes(col.name)) {
        console.log(`Adding missing column '${col.name}' to visitors table...`);
        try {
          await db.run(`ALTER TABLE visitors ADD COLUMN ${col.name} ${col.type}`);
          console.log(`Successfully added column '${col.name}'`);
        } catch (err) {
          // Ignore errors (column might already exist in some cases)
          console.log(`Column '${col.name}' might already exist: ${err.message}`);
        }
      }
    }
  } catch (e) {
    console.error('Error ensuring visitor columns:', e);
  }
}

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  
  // Ensure all required columns exist
  await ensureVisitorColumns(db);
  
  const { page = 1, limit = 20, status, search, startDate, endDate, includeInactive } = req.query;
  
  // Permitir limite maior para busca de todos os visitantes (filtragem local)
  const parsedLimit = Math.min(parseInt(limit) || 20, 10000);
  const offset = (page - 1) * parsedLimit;

  let query = `
    SELECT v.*, p.name as visited_person_name, c.corporate_name as visited_company_name
    FROM visitors v
    LEFT JOIN persons p ON v.visited_person_id = p.id
    LEFT JOIN companies c ON v.visited_company_id = c.id
    WHERE 1=1
  `;
  const params = [];

  // Filtro de contexto de empresa para usuários mobile
  if (req.user.isMobile && req.user.company_id) {
    query += ` AND v.visited_company_id = ?`;
    params.push(req.user.company_id);
  }

  // Por padrão, não mostrar visitantes inativos
  // Para mostrar todos (incluindo inativos), passar includeInactive=true
  if (!includeInactive || includeInactive !== 'true') {
    query += ' AND v.status != ?';
    params.push('inactive');
  }

  if (status) {
    query += ' AND v.status = ?';
    params.push(status);
  }

  if (search) {
    const searchType = req.query.searchType || 'exact'; // 'exact' = qualquer parte, 'firstName' = primeiro nome
    const isNumericSearch = /^\d+$/.test(search.replace(/\D/g, ''));
    
    if (isNumericSearch) {
      // Buscas numéricas: documento/celular são ASCII, LIKE direto
      query += ' AND (v.document LIKE ? OR v.cellphone LIKE ?) ';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm);
    } else if (searchType === 'firstName') {
      // Primeiro nome — agora insensível a acento ("joão" acha "João Silva", "joao" também)
      const nameExpr = buildAccentInsensitiveExpr('v.name');
      const searchTerm = `${normalizeSearchTerm(search)}%`;
      query += ` AND ${nameExpr} LIKE ? `;
      params.push(searchTerm);
    } else {
      // Qualquer parte do nome — também insensível a acento
      const nameExpr = buildAccentInsensitiveExpr('v.name');
      const normTerm = `%${normalizeSearchTerm(search)}%`;
      const rawTerm = `%${search}%`;
      query += ` AND (${nameExpr} LIKE ? OR v.document LIKE ? OR v.cellphone LIKE ?) `;
      params.push(normTerm, rawTerm, rawTerm);
    }
  }

  if (startDate) {
    query += ' AND v.entry_date >= ?';
    params.push(startDate.includes(' ') || startDate.includes('T') ? startDate : `${startDate} 00:00:00`);
  }

  if (endDate) {
    query += ' AND v.entry_date <= ?';
    params.push(endDate.includes(' ') || endDate.includes('T') ? endDate : `${endDate} 23:59:59`);
  }

  query += ' ORDER BY v.name ASC LIMIT ? OFFSET ?';
  params.push(parsedLimit, offset);

  const visitors = await db.all(query, params);

  const countQuery = query.replace(
    /SELECT.*?FROM/s,
    'SELECT COUNT(*) as total FROM'
  ).replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: visitors.map(formatVisitor),
    pagination: {
      page: parseInt(page),
      limit: parsedLimit,
      total: total,
      totalPages: Math.ceil(total / parsedLimit)
    }
  });
});

export const getActive = asyncHandler(async (req, res) => {
  const db = req.db;
  
  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitors = await db.all(
    `SELECT v.*, p.name as visited_person_name, c.corporate_name as visited_company_name
     FROM visitors v
     LEFT JOIN persons p ON v.visited_person_id = p.id
     LEFT JOIN companies c ON v.visited_company_id = c.id
     WHERE v.status = 'on_premises'
     ORDER BY v.name ASC`
  );

  res.json({
    success: true,
    data: visitors.map(formatVisitor)
  });
});

export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get(
    `SELECT v.*, p.name as visited_person_name, c.corporate_name as visited_company_name
     FROM visitors v
     LEFT JOIN persons p ON v.visited_person_id = p.id
     LEFT JOIN companies c ON v.visited_company_id = c.id
     WHERE v.id = ?`,
    [id]
  );

  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  console.log('DEBUG getById - visitor period_start:', visitor.period_start);
  console.log('DEBUG getById - visitor period_end:', visitor.period_end);
  console.log('DEBUG getById - visitor liberation_type:', visitor.liberation_type);

  res.json({
    success: true,
    data: formatVisitor(visitor)
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);
  const tenantId = req.tenantId;
  const {
    name,
    document,
    cellphone,
    email,
    visitor_company,
    visited_company_id: body_visited_company_id,
    visited_person_id: body_visited_person_id,
    reason = null
  } = req.body;

  let visited_person_id = body_visited_person_id;
  let visited_company_id = body_visited_company_id;

  // Se for mobile, vincular automaticamente à empresa do usuário
  if (req.user && req.user.isMobile && req.user.company_id) {
    visited_company_id = req.user.company_id;
  }

  console.log('DEBUG: Criando visitante', { 
    name, 
    document, 
    visited_company_id, 
    visited_person_id, 
    body_v_company: body_visited_company_id,
    user_company: req.user?.company_id 
  });

  if (!name || !document) {
    console.log('DEBUG: 400 - Nome ou documento ausentes');
    return res.status(400).json({
      success: false,
      message: 'Nome e documento são obrigatórios'
    });
  }

  const existingVisitor = await db.get('SELECT * FROM visitors WHERE document = ?', [document]);
  let existingId = null;
  if (existingVisitor) {
    // Se o visitante já existe, permitimos "sobrescrever" (update) se ele não estiver atualmente "dentro" (on_premises)
    // Isso resolve conflitos com pré-cadastros, cadastros inativos ou visitantes que já saíram.
    if (existingVisitor.status !== 'on_premises') {
      console.log(`[Visitor] Reaproveitando cadastro existente ${existingVisitor.id} (status: ${existingVisitor.status}) para novo acesso.`);
      existingId = existingVisitor.id;
    } else {
      return res.status(409).json({
        success: false,
        message: 'Visitante já cadastrado e com acesso ativo (on_premises).',
        data: formatVisitor(existingVisitor)
      });
    }
  }

  if (email && !validateEmail(email)) {
    console.log('DEBUG: 400 - Email inválido');
    return res.status(400).json({
      success: false,
      message: 'Email inválido'
    });
  }

  if (visited_person_id) {
    const person = await db.get('SELECT id FROM persons WHERE id = ? AND status = "active"', [visited_person_id]);
    if (!person) {
      console.log('DEBUG: 400 - Pessoa visitada não encontrada', visited_person_id);
      return res.status(400).json({
        success: false,
        message: 'Pessoa visitada não encontrada'
      });
    }
  }

  if (visited_company_id) {
    const company = await db.get('SELECT id FROM companies WHERE id = ? AND active = 1', [visited_company_id]);
    if (!company) {
      console.log('DEBUG: 400 - Empresa visitada não encontrada', visited_company_id);
      return res.status(400).json({
        success: false,
        message: 'Empresa visitada não encontrada'
      });
    }
  }

  if (!visited_person_id && !visited_company_id) {
    console.log('DEBUG: 400 - Sem pessoa ou empresa visitada');
    return res.status(400).json({
      success: false,
      message: 'Deve informar pessoa ou empresa visitada'
    });
  }

  // Verificar colunas opcionais
  const tableColumns = await getTableColumns(db, 'visitors');
  const hasPhotoBase64 = tableColumns.includes('photo_base64');
  const hasRegistrationNumber = tableColumns.includes('registration_number');
  const hasPhotoUrl = tableColumns.includes('photo_url');
  const hasCardNumber = tableColumns.includes('card_number');
  const hasCardType = tableColumns.includes('card_type');
  const hasLiberationType = tableColumns.includes('liberation_type');
  const hasPeriodStart = tableColumns.includes('period_start');
  const hasPeriodEnd = tableColumns.includes('period_end');
  const hasExpectedExitDate = tableColumns.includes('expected_exit_date');
  const hasPreventAutoExit = tableColumns.includes('prevent_auto_exit');

  // Gerar número de matrícula para visitantes (prefixo 27)
  let registrationNumber = null;
  if (hasRegistrationNumber) {
    registrationNumber = await generateRegistrationNumber(db, '27', 'visitors');
  }

  // Coletar campos adicionais
  const photoBase64 = req.body.photo_base64 || req.body.foto || null;
  console.log('DEBUG: Foto recebida (create):', photoBase64 ? 'Sim - ' + photoBase64.substring(0, 50) + '...' : 'Não');
  console.log('DEBUG: req.body keys:', Object.keys(req.body));
  console.log('DEBUG: req.body keys:', Object.keys(req.body));

  // Processar foto e gerar URL (salvar apenas como arquivo, não salva base64 no banco)
  let photoUrl = req.body.photo_url || null;
  
  // Se não veio foto no corpo mas temos um pré-cadastro, mantemos a foto capturada remotamente
  if (!photoUrl && !photoBase64 && existingId) {
    photoUrl = existingVisitor.photo_url;
  }

  if (!photoUrl && photoBase64) {
    try {
      // Gerar identificador único baseado no próximo ID
      const lastVisitor = await db.get('SELECT id FROM visitors ORDER BY id DESC LIMIT 1');
      const nextNumber = lastVisitor ? lastVisitor.id + 1 : 1;
      const desiredName = `visitor_${String(nextNumber).padStart(6, '0')}`;

      // Processar e salvar a foto como JPG
      console.log('DEBUG: Processando foto base64...');
      const processed = await photoService.processBase64Photo(photoBase64, 'visitor', desiredName, tenantId);
      console.log('DEBUG: Foto processada, URL:', processed.url);
      photoUrl = processed.url;
      console.log('DEBUG: Foto salva em:', photoUrl);
    } catch (photoError) {
      console.error('Erro ao processar foto:', photoError);
    }
  }

  const cardNumber = hasCardNumber ? (req.body.card_number || null) : null;
  const cardType = hasCardType ? (req.body.card_type || 'manual') : null;
  const liberationType = hasLiberationType ? (req.body.liberation_type || 'unica') : null;
  const periodStart = hasPeriodStart ? (req.body.period_start || null) : null;
  const periodEnd = hasPeriodEnd ? (req.body.period_end || null) : null;
  const expectedExitDate = hasExpectedExitDate ? (req.body.expected_exit_date || null) : null;
  const preventAutoExit = hasPreventAutoExit ? (req.body.prevent_auto_exit || 0) : 0;

  const now = new Date().toISOString();
  const statusToSet = req.body.status || 'on_premises';

  // Construir query dinamicamente
  let insertFields = ['name', 'document', 'cellphone', 'email', 'visitor_company', 'visited_person_id', 'visited_company_id', 'reason', 'entry_date', 'status', 'registered_by', 'created_at', 'tenant_id'];
  let insertValues = [name, document, cellphone, email || null, visitor_company || null, visited_person_id || null, visited_company_id || null, reason || '', now, statusToSet, req.user.id, now, tenantId];

  // Adicionar número de matrícula se existir
  if (hasRegistrationNumber && registrationNumber) {
    insertFields.push('registration_number');
    insertValues.push(registrationNumber);
  }

  // Adicionar URL da foto se existir (apenas URL do arquivo, não base64)
  if (hasPhotoUrl && photoUrl) {
    insertFields.push('photo_url');
    insertValues.push(photoUrl);
  }

  // Extrair embedding facial se tiver foto
  if (photoBase64) {
    const hasFaceEmbedding = tableColumns.includes('face_embedding');
    if (hasFaceEmbedding) {
      try {
        const { embedding, error } = await extractEmbedding(photoBase64);
        if (embedding && !error) {
          insertFields.push('face_embedding');
          insertValues.push(JSON.stringify(embedding));
        }
      } catch (embedError) {
        console.warn('Erro ao extrair embedding facial:', embedError);
      }
    }
  }

  if (hasCardNumber) {
    insertFields.push('card_number');
    insertValues.push(cardNumber);
  }
  if (hasCardType) {
    insertFields.push('card_type');
    insertValues.push(cardType);
  }
  if (hasLiberationType) {
    insertFields.push('liberation_type');
    insertValues.push(liberationType);
  }
  if (hasPeriodStart) {
    insertFields.push('period_start');
    insertValues.push(periodStart);
  }
  if (hasPeriodEnd) {
    insertFields.push('period_end');
    insertValues.push(periodEnd);
  }
  if (hasExpectedExitDate) {
    insertFields.push('expected_exit_date');
    insertValues.push(expectedExitDate);
  }
  if (hasPreventAutoExit) {
    insertFields.push('prevent_auto_exit');
    insertValues.push(preventAutoExit);
  }

  let result;
  if (existingId) {
    // Realizar UPDATE
    const setClause = insertFields.map(field => `${field} = ?`).join(', ');
    insertValues.push(existingId);
    result = await db.run(
      `UPDATE visitors SET ${setClause} WHERE id = ?`,
      insertValues
    );
    result.lastID = existingId;
  } else {
    // Realizar INSERT
    const placeholders = insertFields.map(() => '?').join(', ');
    result = await db.run(
      `INSERT INTO visitors (${insertFields.join(', ')}) VALUES (${placeholders})`,
      insertValues
    );
  }

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [result.lastID]);

  // Adicionar à fila de processamento de faces se tiver foto
  if (visitor.photo_url) {
    try {
      await addToFaceQueue(db, req.tenantId, visitor.id, visitor.name, 'visitor', visitor.photo_url);
      console.log(`[faceQueue] Visitante ${visitor.id} adicionado à fila de processamento`);
    } catch (queueError) {
      console.warn('[faceQueue] Erro ao adicionar à fila:', queueError);
    }
  }

  res.status(201).json({
    success: true,
    data: formatVisitor(visitor),
    message: 'Visitante registrado com sucesso'
  });

  // Log audit
  await auditService.logCreate(req, 'visitor', visitor.id, `Cadastro de visitante: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`, visitor);

  // Enfileira no push_outbox (best-effort)
  await enqueueVisitorUpsert(db, req.tenantId, visitor);
});

export const registerExit = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get('SELECT id, status, registration_number FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  if (visitor.status === 'exited') {
    return res.status(400).json({
      success: false,
      message: 'Visitante já registrou saída'
    });
  }

  const exitDate = new Date().toISOString();
  await db.run(
    'UPDATE visitors SET exit_date = ?, status = ? WHERE id = ?',
    [exitDate, 'exited', id]
  );

  // Criar tarefa de exclusão do visitante.
  // target_id = id interno (visitors.id): é o que o comunicador grava como
  // `id` do usuário no equipamento ControlID. Usar matrícula aqui faz o
  // destroy do _excluir_usuario_equipamento não casar e o registro fica
  // órfão (vira duplicata se o visitante for recadastrado).
  await db.run(
    `INSERT INTO access_tasks
     (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
     VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
    [tenantId, id, `Exclusão de visitante por saída manual`]
  );

  // Push: enfileira destroy_objects em todos equip push-enabled
  await enqueueVisitorDelete(db, tenantId, id, visitor.registration_number);

  const updatedVisitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);

  res.json({
    success: true,
    data: formatVisitor(updatedVisitor),
    message: 'Saída registrada com sucesso'
  });

  // Log audit
  await auditService.logAction({
      req,
      action: 'UPDATE',
      entity_type: 'visitor',
      entity_id: id,
      description: `Saída de visitante: ${updatedVisitor.name} (Doc: ${updatedVisitor.document || 'S/N'})`,
      new_values: { status: 'exited', exit_date: exitDate }
  });
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);
  const tenantId = req.tenantId;
  const { id } = req.params;

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Buscar valores antigos para o log de auditoria
  const oldValues = { ...visitor };

  // Verificar colunas disponíveis
  const tableColumns = await getTableColumns(db, 'visitors');

  const {
    name,
    document,
    cellphone,
    email,
    visitor_company,
    visited_person_id,
    visited_company_id,
    reason,
    entry_date,
    exit_date,
    status,
    card_number,
    card_type,
    liberation_type,
    period_start,
    period_end,
    expected_exit_date,
    prevent_auto_exit,
    photo_base64
  } = req.body;

  const hasPhotoBase64 = photo_base64 && typeof photo_base64 === 'string' && photo_base64.length > 0;

  const updateFields = [];
  const updateValues = [];

  // Processar foto base64 se fornecida (salvar apenas como arquivo, não base64 no banco)
  if (req.body.photo_url) {
      if (tableColumns.includes('photo_url')) {
        updateFields.push('photo_url = ?');
        updateValues.push(req.body.photo_url);
      }
  } else if (hasPhotoBase64) {
    try {
      const desiredName = `visitor_${String(id).padStart(6, '0')}`;
      const processed = await photoService.processBase64Photo(photo_base64, 'visitor', desiredName, tenantId);
      const photoUrl = processed.url;
      console.log('DEBUG: Nova foto salva em:', photoUrl);

      if (tableColumns.includes('photo_url')) {
        updateFields.push('photo_url = ?');
        updateValues.push(photoUrl);
      }

      // Somente apagar a antiga se a nova obteve sucesso.
      if (visitor.photo_url && visitor.photo_url !== photoUrl) {
        const oldFilename = visitor.photo_url.split('/').pop();
        try {
          await photoService.deletePhoto(oldFilename, 'visitor');
          console.log('DEBUG: Foto antiga deletada:', oldFilename);
        } catch (deleteError) {
          console.warn('Erro ao deletar foto antiga:', deleteError);
        }
      }
    } catch (photoError) {
      console.error('Erro ao processar foto:', photoError);
    }
  }

  if (name !== undefined) { updateFields.push('name = ?'); updateValues.push(name); }
  if (document !== undefined) { updateFields.push('document = ?'); updateValues.push(document); }
  if (cellphone !== undefined) { updateFields.push('cellphone = ?'); updateValues.push(cellphone); }
  if (email !== undefined) { updateFields.push('email = ?'); updateValues.push(email); }
  if (visitor_company !== undefined) { updateFields.push('visitor_company = ?'); updateValues.push(visitor_company); }
  if (visited_person_id !== undefined) { updateFields.push('visited_person_id = ?'); updateValues.push(visited_person_id || null); }
  if (visited_company_id !== undefined) { updateFields.push('visited_company_id = ?'); updateValues.push(visited_company_id || null); }
  if (reason !== undefined) { updateFields.push('reason = ?'); updateValues.push(reason); }
  if (entry_date !== undefined) { updateFields.push('entry_date = ?'); updateValues.push(entry_date); }
  if (exit_date !== undefined) { updateFields.push('exit_date = ?'); updateValues.push(exit_date); if (exit_date) { updateFields.push('status = ?'); updateValues.push('exited'); } }
  // Se status for definido explicitamente, usar esse valor
  if (status !== undefined) { 
    updateFields.push('status = ?'); 
    updateValues.push(status);
    // Se status for 'on_premises', limpar exit_date
    if (status === 'on_premises') {
      updateFields.push('exit_date = ?');
      updateValues.push(null);
    }
  }
  if (card_number !== undefined) { updateFields.push('card_number = ?'); updateValues.push(card_number); }
  if (card_type !== undefined) { updateFields.push('card_type = ?'); updateValues.push(card_type); }
  if (liberation_type !== undefined) { updateFields.push('liberation_type = ?'); updateValues.push(liberation_type); }
  // Só atualizar período se for fornecido e não for nulo/vazio
  if (period_start !== undefined && period_start !== null && period_start !== '') { updateFields.push('period_start = ?'); updateValues.push(period_start); }
  if (period_end !== undefined && period_end !== null && period_end !== '') { updateFields.push('period_end = ?'); updateValues.push(period_end); }
  
  // Se estiver definindo um novo período de liberação (period_start ou period_end)
  // e o visitante não estiver ativo (on_premises), ativar automaticamente
  if ((period_start !== undefined || period_end !== undefined) && visitor.status !== 'on_premises') {
    updateFields.push('status = ?');
    updateValues.push('on_premises');
    // Limpar data de saída para visitantes que estavam inativos
    if (visitor.exit_date) {
      updateFields.push('exit_date = ?');
      updateValues.push(null);
    }
  }
  if (expected_exit_date !== undefined) { updateFields.push('expected_exit_date = ?'); updateValues.push(expected_exit_date); }
  if (prevent_auto_exit !== undefined) { updateFields.push('prevent_auto_exit = ?'); updateValues.push(prevent_auto_exit); }

  if (updateFields.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum campo para atualizar'
    });
  }

  updateValues.push(id);
  await db.run(
    `UPDATE visitors SET ${updateFields.join(', ')} WHERE id = ?`,
    updateValues
  );

  const updatedVisitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);

  // Adicionar à fila de processamento de faces se tiver foto
  if (updatedVisitor.photo_url) {
    try {
      await addToFaceQueue(db, req.tenantId, updatedVisitor.id, updatedVisitor.name, 'visitor', updatedVisitor.photo_url);
      console.log(`[faceQueue] Visitante ${updatedVisitor.id} atualizado e adicionado à fila de processamento`);
    } catch (queueError) {
      console.warn('[faceQueue] Erro ao adicionar à fila:', queueError);
    }
  }

  res.json({
    success: true,
    data: formatVisitor(updatedVisitor),
    message: 'Visitante atualizado com sucesso'
  });

  // Log audit
  await auditService.logUpdate(req, 'visitor', id, `Atualização de visitante: ${updatedVisitor.name} (Doc: ${updatedVisitor.document || 'S/N'})`, oldValues, updatedVisitor);

  // Enfileira no push_outbox (idempotente; create_or_modify_objects atualiza)
  await enqueueVisitorUpsert(db, req.tenantId, updatedVisitor);
});


export const uploadPhoto = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Arquivo não enviado'
    });
  }

  const visitor = await db.get('SELECT id, photo_url FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Deletar foto anterior se existir
  if (visitor.photo_url) {
    const filename = visitor.photo_url.split('/').pop();
    await photoService.deletePhoto(filename, 'visitor');
  }

  // Processar e salvar a foto com tenant_id como prefixo
  // Gerar um identificador único no formato visitor_{numero}
  const desiredName = `visitor_${String(id).padStart(6, '0')}`; // Ex: visitor_000001
  const processed = await photoService.processPhoto(req.file, 'visitor', desiredName, tenantId);
  const photoUrl = processed.url;

  await db.run(
    'UPDATE visitors SET photo_url = ? WHERE id = ?',
    [photoUrl, id]
  );

  res.json({
    success: true,
    data: { photo_url: photoUrl },
    message: 'Foto enviada com sucesso'
  });
});

// Inativar visitante (soft delete) - ao invés de excluir, marca como inativo
export const inactivateVisitor = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const tenantId = req.tenantId;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Se já estiver inativo, retornar erro
  if (visitor.status === 'inactive') {
    return res.status(400).json({
      success: false,
      message: 'Visitante já está inativo'
    });
  }

  // Inativar o visitante (soft delete)
  await db.run(
    'UPDATE visitors SET status = ?, updated_at = ? WHERE id = ?',
    ['inactive', new Date().toISOString(), id]
  );

  res.json({
    success: true,
    message: 'Visitante inativado com sucesso'
  });

  // Log audit
  await auditService.logAction(req, {
    action: 'INACTIVATE',
    entityType: 'visitor',
    entityId: id,
    description: `Visitante inativado: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`
  });

  // Inativar = remover do equipamento. Enfileira destroy_objects.
  await enqueueVisitorDelete(db, tenantId, id, visitor.registration_number);
});

// Reativar visitante
export const reactivateVisitor = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const tenantId = req.tenantId;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Se não estiver inativo, retornar erro
  if (visitor.status !== 'inactive') {
    return res.status(400).json({
      success: false,
      message: 'Visitante não está inativo'
    });
  }

  // Reativar o visitante (voltar para exited pois não está nas instalações)
  await db.run(
    'UPDATE visitors SET status = ?, updated_at = ? WHERE id = ?',
    ['exited', new Date().toISOString(), id]
  );

  res.json({
    success: true,
    message: 'Visitante reativado com sucesso'
  });

  // Log audit
  await auditService.logAction(req, {
    action: 'REACTIVATE',
    entityType: 'visitor',
    entityId: id,
    description: `Visitante reativado: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`
  });
});

// Inativação em massa de visitantes
export const bulkInactivate = asyncHandler(async (req, res) => {
  const db = req.db;
  const { ids } = req.body;
  const tenantId = req.tenantId;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'IDs dos visitantes são obrigatórios'
    });
  }

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const exitDate = new Date().toISOString();

  // Inativar (registrar saída) de todos os visitantes
  const placeholders = ids.map(() => '?').join(',');
  await db.run(
    `UPDATE visitors SET status = 'exited', exit_date = ?, updated_at = ? WHERE id IN (${placeholders}) AND status != 'exited'`,
    [exitDate, exitDate, ...ids]
  );

  // Criar tarefas de exclusão do visitante para o equipamento.
  // target_id = visitors.id interno (mesma justificativa do remove individual).
  const visitors = await db.all(`SELECT id, registration_number FROM visitors WHERE id IN (${placeholders})`, ids);
  for (const v of visitors) {
    await db.run(
      `INSERT INTO access_tasks
       (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
       VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
      [tenantId, v.id, `Exclusão de visitante por saída manual em massa`]
    );
    // Push: enfileira destroy em todos equip push-enabled
    await enqueueVisitorDelete(db, tenantId, v.id, v.registration_number);
  }

  res.json({
    success: true,
    message: `${ids.length} visitante(s) com saída registrada com sucesso`
  });

  // Log audit
  await auditService.logAction({
    req,
    action: 'BULK_INACTIVATE',
    entity_type: 'visitor',
    entity_id: null,
    description: `Registro de saída em massa: ${ids.length} visitantes`,
    new_values: { status: 'exited', exit_date: exitDate }
  });
});

// Exclusão permanente de visitante (apenas para registros inativos)
export const forceDeleteVisitor = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const tenantId = req.tenantId;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Apenas visitantes com saída registrada (exited) ou pré-cadastro (pending_capture) podem ser excluídos permanentemente
  if (visitor.status !== 'exited' && visitor.status !== 'pending_capture') {
    return res.status(400).json({
      success: false,
      message: 'Apenas visitantes com saída registrada ou em pré-cadastro podem ser excluídos permanentemente'
    });
  }

  // Deletar foto se existir
  if (visitor.photo_url) {
    const filename = visitor.photo_url.split('/').pop();
    await photoService.deletePhoto(filename, 'visitor');
  }

  // Deletar visitante
  await db.run('DELETE FROM visitors WHERE id = ?', [id]);

  res.json({
    success: true,
    message: 'Visitante excluído permanentemente'
  });

  // Log audit
  await auditService.logDelete(req, 'visitor', id, `Exclusão permanente de visitante: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`, visitor);

  // Enfileira destroy_objects no push_outbox (visitor já foi removido da DB)
  await enqueueVisitorDelete(db, tenantId, id, visitor.registration_number);
});

// Modificar deleteVisitor para inativar ao invés de excluir
export const deleteVisitor = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const tenantId = req.tenantId;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({
      success: false,
      message: 'Visitante não encontrado'
    });
  }

  // Se já tiver saída registrada ou for pré-cadastro, fazer exclusão permanente
  if (visitor.status === 'exited' || visitor.status === 'pending_capture') {
    // Deletar foto se existir
    if (visitor.photo_url) {
      const filename = visitor.photo_url.split('/').pop();
      await photoService.deletePhoto(filename, 'visitor');
    }

    // Deletar visitante
    await db.run('DELETE FROM visitors WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Visitante excluído permanentemente'
    });

    // Log audit
    await auditService.logAction({
      req,
      action: 'DELETE',
      entity_type: 'visitor',
      entity_id: id,
      description: `Exclusão permanente de visitante: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`,
      old_values: visitor
    });
    return;
  }

  const exitDate = new Date().toISOString();

  // Inativar o visitante (soft delete -> registrar saída)
  await db.run(
    'UPDATE visitors SET status = ?, exit_date = ?, updated_at = ? WHERE id = ?',
    ['exited', exitDate, exitDate, id]
  );

  // Criar tarefa de exclusão do visitante para o equipamento.
  // target_id = visitors.id interno (mesma justificativa dos outros deletes).
  await db.run(
    `INSERT INTO access_tasks
     (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
     VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', datetime('now'), ?, 'all')`,
    [tenantId, id, `Exclusão de visitante por exclusão lógica`]
  );

  res.json({
    success: true,
    message: 'Visitante inativado com sucesso'
  });

  // Log audit
  await auditService.logAction(req, {
    action: 'INACTIVATE',
    entityType: 'visitor',
    entityId: id,
    description: `Inativação de visitante: ${visitor.name} (Doc: ${visitor.document || 'S/N'})`
  });
});

export const getStats = asyncHandler(async (req, res) => {
  const db = req.db;

  // Ensure all required columns exist
  await ensureVisitorColumns(db);

  const total = await db.get('SELECT COUNT(*) as count FROM visitors');
  const onPremises = await db.get("SELECT COUNT(*) as count FROM visitors WHERE status = 'on_premises'");
  const exited = await db.get("SELECT COUNT(*) as count FROM visitors WHERE status = 'exited'");

  res.json({
    success: true,
    data: {
      total: total.count,
      on_premises: onPremises.count,
      exited: exited.count
    }
  });
});

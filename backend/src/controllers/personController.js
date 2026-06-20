import { generateRegistrationNumber, generateUniqueRandomRegistrationNumber, hashPassword } from '../utils/generators.js';
import { formatPerson, formatPersonData, paginate } from '../utils/formatters.js';
import { validateCPF, validateEmail } from '../utils/validators.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { normalizeSearchTerm, buildAccentInsensitiveExpr } from '../utils/searchUtils.js';
import photoService from '../services/photoService.js';
import { extractEmbedding } from '../services/faceEmbeddingService.js';
import { addToFaceQueue } from './faceQueueController.js';
import auditService from '../services/auditService.js';
import { enqueueForActiveDevices, enqueueForAuthorizedDevices, newBatchId } from '../services/pushOutbox.js';
import { toDeviceUserId } from '../services/deviceUserId.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

// Helper function to get tenant limits from config
async function getTenantLimits(db) {
  try {
    const limits = await db.get('SELECT max_pessoas, max_equipamentos FROM tenant_limits LIMIT 1');
    return limits || {
      max_pessoas: 1000,
      max_equipamentos: 50
    };
  } catch (e) {
    return {
      max_pessoas: 1000,
      max_equipamentos: 50
    };
  }
}

// Helper function to count current people for tenant
async function countPeople(db) {
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM persons WHERE status = ?', ['active']);
    return result?.count || 0;
  } catch (e) {
    return 0;
  }
}

// Helper function to count current vehicles (equipamentos) for tenant
async function countVehicles(db) {
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM vehicles');
    return result?.count || 0;
  } catch (e) {
    return 0;
  }
}

// Ensure person_groups table exists at runtime (safe idempotent fallback)
async function ensurePersonGroupsTable(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS person_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(person_id, group_id)
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_person_groups_person ON person_groups(person_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_person_groups_group ON person_groups(group_id)');
}

// Tradutor: dados de pessoa → comandos FCGI para o equipamento Control iD.
// PRODUÇÃO: id no equipamento = MATRÍCULA (registration_number). Compatível
// com cadastros existentes do Comunicador legado — create_or_modify_objects
// apenas atualiza o registro já existente, não duplica.
async function buildPersonRegisterCommands({ person, tenantId, deviceId, photoBase64 }) {
  const batchId = newBatchId();
  const origin = `person:upsert:${person.id}`;
  const equipUserId = toDeviceUserId('person', person.id, person.registration_number);
  const registration = person.registration_number
    ? String(person.registration_number)
    : `${tenantId}_${person.id}`;
  const cmds = [
    {
      deviceId, batchId, batchOrder: 0, origin,
      endpoint: 'create_or_modify_objects',
      body: {
        object: 'users',
        values: [{
          id: equipUserId,
          registration,
          name: person.name || '',
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

async function buildPersonQrCodeCommands({ person, tenantId, deviceId, qrcodeValue }) {
  if (!qrcodeValue || !deviceId) return [];

  const batchId = newBatchId();
  const origin = `person:qrcode:${person.id}:${qrcodeValue}`;
  const equipUserId = toDeviceUserId('person', person.id, person.registration_number);

  return [
    {
      deviceId,
      batchId,
      batchOrder: 0,
      origin,
      endpoint: 'destroy_objects',
      body: {
        object: 'qrcodes',
        where: {
          qrcodes: {
            value: qrcodeValue
          }
        }
      }
    },
    {
      deviceId,
      batchId,
      batchOrder: 1,
      origin,
      endpoint: 'create_or_modify_objects',
      body: {
        object: 'qrcodes',
        values: [{
          value: qrcodeValue,
          user_id: equipUserId
        }]
      }
    }
  ];
}

// Carrega foto do disco em base64 (best-effort). Retorna null se não achar.
async function loadPhotoBase64IfExists(photoUrl) {
  if (!photoUrl) return null;
  try {
    const relativePath = photoUrl.replace(/^\//, '');
    const candidates = [
      join(process.cwd(), 'public', relativePath),
      join(process.cwd(), 'uploads', relativePath),
      join(process.cwd(), relativePath),
    ];
    for (const p of candidates) {
      try {
        const buf = await readFile(p);
        return buf.toString('base64');
      } catch { /* tenta próximo */ }
    }
    return null;
  } catch {
    return null;
  }
}

async function getTableColumns(db, tableName) {
  try {
    const tableInfo = await db.all(`PRAGMA table_info(${tableName})`);
    return tableInfo.map(col => col.name);
  } catch (e) {
    return [];
  }
}

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { page = 1, limit = 20, search, group_id, status = 'active' } = req.query;
  
  // Permitir limite maior para busca de todas as pessoas (filtragem local)
  const parsedLimit = Math.min(parseInt(limit) || 20, 10000);
  const offset = (page - 1) * parsedLimit;

  // Verificar se a coluna company_id existe na tabela persons
  let hasCompanyId = false;
  try {
    const tableInfo = await db.all("PRAGMA table_info(persons)");
    hasCompanyId = tableInfo.some(col => col.name === 'company_id');
  } catch (e) {
    // Se não conseguir verificar, assume que não tem
    hasCompanyId = false;
  }

  let query = `SELECT p.*, g.name as group_name`;
  
  if (hasCompanyId) {
    query += `, c.corporate_name as company_name`;
  } else {
    query += `, NULL as company_name`;
  }
  
  query += ` FROM persons p LEFT JOIN groups g ON p.group_id = g.id`;
  
  if (hasCompanyId) {
    query += ` LEFT JOIN companies c ON p.company_id = c.id`;
  }
  
  query += ` WHERE 1=1`;
  
  const params = [];

  // Filtro de contexto de empresa para usuários mobile
  if (req.user.isMobile && req.user.company_id && hasCompanyId) {
    query += ` AND p.company_id = ?`;
    params.push(req.user.company_id);
  }

  // NOTA: O tenant_id NÃO existe na tabela persons.
  // Aislar tenant já é feito no nível do banco de dados (cada tenant tem seu próprio .db)
  
  if (status) {
    query += ' AND p.status = ?';
    params.push(status === 'active' ? 'active' : 'inactive');
  }

  if (search) {
    // Verificar se registration_number existe antes de usar na busca
    const tableColumns = await getTableColumns(db, 'persons');
    const hasRegistrationNumber = tableColumns.includes('registration_number');

    // Busca insensível a caso E acento — antes "joão" não achava "JOAO" nem "joao".
    // Normalizamos o termo em JS e o SQL aplica REPLACE+LOWER na coluna name.
    const searchTerm = `%${normalizeSearchTerm(search)}%`;
    const nameExpr = buildAccentInsensitiveExpr('p.name');
    // CPF / registration_number / email são ASCII puro, LIKE direto basta
    const rawTerm = `%${search}%`;

    if (hasRegistrationNumber && hasCompanyId) {
      const companyExpr1 = buildAccentInsensitiveExpr('c.corporate_name');
      const companyExpr2 = buildAccentInsensitiveExpr('c.trading_name');
      query += ` AND (${nameExpr} LIKE ? OR p.registration_number LIKE ? OR p.cpf LIKE ? OR p.email LIKE ? OR ${companyExpr1} LIKE ? OR ${companyExpr2} LIKE ?)`;
      params.push(searchTerm, rawTerm, rawTerm, rawTerm, searchTerm, searchTerm);
    } else if (hasRegistrationNumber) {
      query += ` AND (${nameExpr} LIKE ? OR p.registration_number LIKE ? OR p.cpf LIKE ? OR p.email LIKE ?)`;
      params.push(searchTerm, rawTerm, rawTerm, rawTerm);
    } else if (hasCompanyId) {
      const companyExpr1 = buildAccentInsensitiveExpr('c.corporate_name');
      const companyExpr2 = buildAccentInsensitiveExpr('c.trading_name');
      query += ` AND (${nameExpr} LIKE ? OR p.cpf LIKE ? OR p.email LIKE ? OR ${companyExpr1} LIKE ? OR ${companyExpr2} LIKE ?)`;
      params.push(searchTerm, rawTerm, rawTerm, searchTerm, searchTerm);
    } else {
      query += ` AND (${nameExpr} LIKE ? OR p.cpf LIKE ? OR p.email LIKE ?)`;
      params.push(searchTerm, rawTerm, rawTerm);
    }
  }

  if (group_id) {
    // Verificar se a tabela person_groups existe
    let hasPersonGroupsTable = false;
    try {
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='person_groups'");
      hasPersonGroupsTable = tables.length > 0;
    } catch (e) {
      hasPersonGroupsTable = false;
    }
    
    if (hasPersonGroupsTable) {
      // Busca pessoas que têm o group_id como grupo principal OU que estão na tabela person_groups
      query += ' AND (p.group_id = ? OR p.id IN (SELECT person_id FROM person_groups WHERE group_id = ?))';
      params.push(group_id, group_id);
    } else {
      query += ' AND p.group_id = ?';
      params.push(group_id);
    }
  }

  query += ' ORDER BY p.name ASC LIMIT ? OFFSET ?';
  params.push(parsedLimit, offset);

  const persons = await db.all(query, params);

  // Otimização: buscar todos os grupos e veículos em queries únicas ao invés de N+1
  const personIds = persons.map(p => p.id);
  
  let groupsMap = new Map();
  let vehiclesMap = new Map();
  
  if (personIds.length > 0) {
    // Buscar todos os grupos de uma vez
    const allGroups = await db.all(
      `SELECT pg.person_id, g.id, g.name 
       FROM person_groups pg 
       JOIN groups g ON g.id = pg.group_id 
       WHERE pg.person_id IN (${personIds.map(() => '?').join(',')})`,
      personIds
    );
    
    // Agrupar grupos por pessoa
    for (const g of allGroups) {
      if (!groupsMap.has(g.person_id)) {
        groupsMap.set(g.person_id, []);
      }
      groupsMap.get(g.person_id).push({ id: g.id, name: g.name });
    }
    
    // Buscar todos os veículos de uma vez com informações da empresa
    let allVehicles = [];
    if (personIds.length > 0) {
      allVehicles = await db.all(
        `SELECT v.*, 
                c.corporate_name as company_corporate_name, 
                c.trading_name as company_trading_name
         FROM vehicles v 
         LEFT JOIN companies c ON v.company_id = c.id 
         WHERE v.person_id IN (${personIds.map(() => '?').join(',')})`,
        personIds
      );
      
      // Adicionar nome da empresa aos veículos
      for (const v of allVehicles) {
        v.company_display_name = v.company_corporate_name || v.company_trading_name || (v.company_id ? 'Empresa #' + v.company_id : null);
      }
    }
    
    // Mapear veículos por pessoa (agora como array para suportar múltiplos veículos)
    for (const v of allVehicles) {
      if (!vehiclesMap.has(v.person_id)) {
        vehiclesMap.set(v.person_id, []);
      }
      vehiclesMap.get(v.person_id).push(v);
    }
  }
  
  // Attach groups and vehicles to each person
  for (const p of persons) {
    p.groups = groupsMap.get(p.id) || [];
    p.vehicles = vehiclesMap.get(p.id) || [];
    // Manter compatibilidade com código que usa 'vehicle' (singular)
    p.vehicle = p.vehicles[0] || null;
  }

  const countQuery = query.replace(
    /SELECT.*?FROM/s,
    'SELECT COUNT(*) as total FROM'
  ).replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  const paginationResult = {
    success: true,
    data: persons.map(p => formatPersonData(formatPerson(p))),
    pagination: {
      page: parseInt(page),
      limit: parseInt(parsedLimit),
      total: total,
      totalPages: Math.ceil(total / parsedLimit)
    }
  };
  
  console.log('[DEBUG] Persons pagination - page:', page, 'limit:', parsedLimit, 'total:', total, 'totalPages:', Math.ceil(total / parsedLimit));
  console.log('[DEBUG] Full pagination response:', JSON.stringify(paginationResult.pagination));
  
  res.json(paginationResult);
});

export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  // Verificar se a coluna company_id existe
  let hasCompanyId = false;
  try {
    const tableInfo = await db.all("PRAGMA table_info(persons)");
    hasCompanyId = tableInfo.some(col => col.name === 'company_id');
  } catch (e) {
    hasCompanyId = false;
  }

  let query = `SELECT p.*, g.name as group_name`;
  if (hasCompanyId) {
    query += `, c.corporate_name as company_name`;
  } else {
    query += `, NULL as company_name`;
  }
  query += ` FROM persons p LEFT JOIN groups g ON p.group_id = g.id`;
  if (hasCompanyId) {
    query += ` LEFT JOIN companies c ON p.company_id = c.id`;
  }
  // O tenant_id NÃO existe na tabela persons.
  // O isolamento de tenant já é feito no nível do banco de dados.
  query += ` WHERE p.id = ?`;

  const person = await db.get(query, [id]);

  if (!person) {
    // Tentar buscar para dar mensagem mais específica
    const personAnyTenant = await db.get('SELECT id FROM persons WHERE id = ?', [id]);
    if (personAnyTenant) {
      return res.status(404).json({
        success: false,
        message: 'Pessoa não encontrada neste tenant'
      });
    }
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }


    // Attach groups
    await ensurePersonGroupsTable(db);
    const groups = await db.all('SELECT g.id, g.name FROM groups g JOIN person_groups pg ON g.id = pg.group_id WHERE pg.person_id = ?', [id]);

  // Buscar veículos com informações da empresa (LEFT JOIN)
  const vehicles = await db.all(`
    SELECT v.*, 
           c.corporate_name as company_corporate_name, 
           c.trading_name as company_trading_name
    FROM vehicles v 
    LEFT JOIN companies c ON v.company_id = c.id 
    WHERE v.person_id = ?
  `, [id]);
  
  // Adicionar nome da empresa aos veículos
  for (const v of vehicles) {
    v.company_display_name = v.company_corporate_name || v.company_trading_name || (v.company_id ? 'Empresa #' + v.company_id : null);
  }
  
  const vehicle = vehicles.length > 0 ? vehicles[0] : null;
  console.log('[DEBUG] getById - Vehicle query result for person_id', id + ':', vehicle);
  console.log('[DEBUG] getById - All vehicles for person_id', id + ':', vehicles);
  res.json({
    success: true,
    data: formatPersonData({
      ...formatPerson(person),
      vehicle: vehicle || null,
      vehicles: vehicles || [],
      groups: groups || []
    })
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const {
    id,
    registration_number,
    // Alias vindo do frontend (pessoa-matricula)
    matricula,
    name,
    cpf,
    cellphone,
    cellphone_ddi,
    email,
    lgpd_consent = false,
    vehicle: vehicleInput,
    vehicles: vehiclesInput,
    groups: groupsInput,
    password,
    mobile_permissions,
    ...otherData
  } = req.body;

  console.log('[DEBUG] cellphone_ddi recebido:', cellphone_ddi);

  // Verificar limite de pessoas
  const limits = await getTenantLimits(db);
  const currentCount = await countPeople(db);
  if (currentCount >= limits.max_pessoas) {
    return res.status(429).json({
      success: false,
      message: `Limite de pessoas (${limits.max_pessoas}) atingido para este tenant`,
      current: currentCount,
      limit: limits.max_pessoas
    });
  }

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Nome é obrigatório'
    });
  }

  // Verificar se já existe pessoa ATIVA com o mesmo nome (exceto se for a mesma pessoa)
  // A verificação agora inclui o ID para permitir que uma pessoa seja editada sem erro de nome duplicado
  let query = 'SELECT id, name FROM persons WHERE LOWER(name) = LOWER(?) AND status = ?';
  let params = [name.trim(), 'active'];
  
  if (id) {
    query += ' AND id != ?';
    params.push(id);
  }
  
  const existingByName = await db.get(query, params);
  if (existingByName) {
    return res.status(400).json({
      success: false,
      message: 'Já existe uma pessoa cadastrada com este nome'
    });
  }

  if (cpf && !validateCPF(cpf)) {
    return res.status(400).json({
      success: false,
      message: 'CPF inválido'
    });
  }

  if (email && !validateEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Email inválido'
    });
  }

  if (cpf) {
    let cpfQuery = 'SELECT id FROM persons WHERE cpf = ?';
    let cpfParams = [cpf];
    if (id) {
      cpfQuery += ' AND id != ?';
      cpfParams.push(id);
    }
    const existing = await db.get(cpfQuery, cpfParams);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'CPF já cadastrado'
      });
    }
  }

  if (email) {
    let emailQuery = 'SELECT id FROM persons WHERE email = ?';
    let emailParams = [email];
    if (id) {
      emailQuery += ' AND id != ?';
      emailParams.push(id);
    }
    const existingEmail = await db.get(emailQuery, emailParams);
    if (existingEmail) {
      return res.status(400).json({
        success: false,
        message: 'Email já cadastrado'
      });
    }
  }

  // Verificar quais colunas existem na tabela
  const tableColumns = await getTableColumns(db, 'persons');
  const hasRegistrationNumber = tableColumns.includes('registration_number');
  const hasCompanyId = tableColumns.includes('company_id');
  const hasStreetNumber = tableColumns.includes('street_number');
  const hasAddressComplement = tableColumns.includes('address_complement');
  const hasNationality = tableColumns.includes('nationality');
  const hasNaturality = tableColumns.includes('naturality');
  const hasExtension = tableColumns.includes('extension');
  const hasCellphoneDdi = tableColumns.includes('cellphone_ddi');
  const hasPasswordHash = tableColumns.includes('password_hash');
  const hasMobilePermissions = tableColumns.includes('mobile_permissions');

  // Usar matrícula enviada pelo frontend como alias de registration_number
  let regNumber = registration_number || matricula;
  if (hasRegistrationNumber) {
    if (!regNumber) {
      regNumber = await generateUniqueRandomRegistrationNumber(db);
      if (!regNumber) {
        // Se não conseguiu gerar (coluna não existe), usa um valor padrão baseado no timestamp
        regNumber = `${Date.now()}`.slice(-6);
      }
    } else {
      const existingReg = await db.get('SELECT id FROM persons WHERE registration_number = ?', [regNumber]);
      if (existingReg) {
        return res.status(400).json({
          success: false,
          message: 'Matrícula já existe'
        });
      }
    }
  }

  // Construir INSERT dinamicamente baseado nas colunas existentes
  const insertFields = ['name', 'cpf', 'rg', 'birth_date', 'gender', 'marital_status',
    'profession', 'position', 'admission_date', 'phone', 'cellphone', 'email',
    'father_name', 'mother_name', 'address', 'neighborhood', 'city', 'state', 'cep'];
  const insertValues = [
    name, cpf || null, otherData.rg || null,
    otherData.birth_date || null, otherData.gender || null,
    otherData.marital_status || null, otherData.profession || null,
    otherData.position || null, otherData.admission_date || null,
    otherData.phone || null, cellphone || '', email || '',
    otherData.father_name || null, otherData.mother_name || null,
    otherData.address || null, otherData.neighborhood || null,
    otherData.city || null, otherData.state || null, otherData.cep || null
  ];

  if (hasRegistrationNumber) {
    insertFields.push('registration_number');
    insertValues.push(regNumber);
  }
  if (hasStreetNumber) {
    insertFields.push('street_number');
    insertValues.push(otherData.street_number || null);
  }
  if (hasAddressComplement) {
    insertFields.push('address_complement');
    insertValues.push(otherData.address_complement || null);
  }
  if (tableColumns.includes('group_id')) {
    insertFields.push('group_id');
    insertValues.push(otherData.group_id || null);
  }
  if (hasCompanyId) {
    insertFields.push('company_id');
    insertValues.push(otherData.company_id || null);
  }
  if (hasCellphoneDdi) {
    insertFields.push('cellphone_ddi');
    insertValues.push(cellphone_ddi || '+55');
  }
  if (tableColumns.includes('status')) {
    insertFields.push('status');
    insertValues.push('active');
  }
  if (tableColumns.includes('lgpd_consent')) {
    insertFields.push('lgpd_consent');
    insertValues.push(lgpd_consent ? 1 : 0);
  }
  if (tableColumns.includes('consent_date')) {
    insertFields.push('consent_date');
    insertValues.push(lgpd_consent ? new Date().toISOString() : null);
  }
  if (hasNationality) {
    insertFields.push('nationality');
    insertValues.push(otherData.nationality || null);
  }
  if (hasNaturality) {
    insertFields.push('naturality');
    insertValues.push(otherData.naturality || null);
  }
  if (hasExtension) {
    insertFields.push('extension');
    insertValues.push(otherData.extension || null);
  }
  if (tableColumns.includes('created_at')) {
    insertFields.push('created_at');
    insertValues.push(new Date().toISOString());
  }

  // Novos campos Mobile
  if (hasPasswordHash && password) {
    const hashedPassword = await hashPassword(password);
    insertFields.push('password_hash');
    insertValues.push(hashedPassword);
  }

  if (hasMobilePermissions) {
    const perms = mobile_permissions ? (typeof mobile_permissions === 'string' ? mobile_permissions : JSON.stringify(mobile_permissions)) : JSON.stringify(['equipments', 'encomendas', 'monitoramento']);
    insertFields.push('mobile_permissions');
    insertValues.push(perms);
  }
  if (tableColumns.includes('updated_at')) {
    insertFields.push('updated_at');
    insertValues.push(new Date().toISOString());
  }
  if (tableColumns.includes('created_by')) {
    insertFields.push('created_by');
    insertValues.push(req.user.id);
  }
  
  // Extrair embedding facial se tiver foto (base64)
  const fotoRawCreate = otherData.foto || otherData.photo_base64 || null;
  const fotoBase64ForCreate = (typeof fotoRawCreate === 'string' && fotoRawCreate.startsWith('data:image'))
    ? fotoRawCreate
    : null;
  const hasFaceEmbeddingCol = tableColumns.includes('face_embedding');
  if (hasFaceEmbeddingCol && fotoBase64ForCreate) {
    try {
      const { embedding, error } = await extractEmbedding(fotoBase64ForCreate);
      if (embedding && !error) {
        insertFields.push('face_embedding');
        insertValues.push(JSON.stringify(embedding));
      }
    } catch (embedError) {
      console.warn('Erro ao extrair embedding facial:', embedError);
    }
  }

  // Manter compatibilidade: salvar base64 na coluna photo_base64 se existir
  const hasPhotoBase64 = tableColumns.includes('photo_base64');
  if (hasPhotoBase64 && fotoBase64ForCreate) {
    insertFields.push('photo_base64');
    insertValues.push(fotoBase64ForCreate);
  }

  const placeholders = insertFields.map(() => '?').join(', ');
  const now = new Date().toISOString();
  const result = await db.run(
    `INSERT INTO persons (${insertFields.join(', ')}) VALUES (${placeholders})`,
    insertValues
  );

    const insertedId = result.lastID;

  // Processar foto base64 → arquivo e salvar photo_url (usando ID do banco como nome único)
  if (fotoBase64ForCreate && tableColumns.includes('photo_url')) {
    try {
      const desiredName = `person_${insertedId}`;
      const processed = await photoService.processBase64Photo(fotoBase64ForCreate, 'person', desiredName, req.tenantId);
      if (tableColumns.includes('photo_base64')) {
        await db.run('UPDATE persons SET photo_url = ?, photo_base64 = NULL WHERE id = ?', [processed.url, insertedId]);
      } else {
        await db.run('UPDATE persons SET photo_url = ? WHERE id = ?', [processed.url, insertedId]);
      }
      console.log(`[photo] Foto processada para pessoa ${insertedId}: ${processed.url}`);
    } catch (photoErr) {
      console.warn('[photo] Erro ao processar foto no cadastro:', photoErr);
    }
  }

    // Handle multiple groups if provided
    const groupIds = otherData.group_ids || otherData.groupIds || null;
    await ensurePersonGroupsTable(db);
    if (groupIds && Array.isArray(groupIds)) {
      // remove any existing (shouldn't be any for new)
      await db.run('DELETE FROM person_groups WHERE person_id = ?', [insertedId]);
      for (const gid of groupIds) {
        await db.run('INSERT OR IGNORE INTO person_groups (person_id, group_id, created_at) VALUES (?, ?, ?)', [insertedId, gid, now]);
      }
      // optionally update primary group in persons table using first group
      await db.run('UPDATE persons SET group_id = ? WHERE id = ?', [groupIds[0] || null, insertedId]);
    }

    // Vincular pessoa como proprietária da empresa (se company_id for fornecido)
    const companyId = otherData.company_id || null;
    if (companyId) {
      try {
        // Verificar se já existe vínculo de propriedade
        const existingOwner = await db.get(
          'SELECT id FROM company_owners WHERE company_id = ? AND person_id = ?',
          [companyId, insertedId]
        );
        // Se não existir, adicionar como proprietário
        if (!existingOwner) {
          await db.run(
            'INSERT INTO company_owners (company_id, person_id) VALUES (?, ?)',
            [companyId, insertedId]
          );
          console.log(`Pessoa ${insertedId} vinculada como proprietária da empresa ${companyId}`);
        }
      } catch (ownerError) {
        console.warn('Erro ao vincular proprietário:', ownerError);
        // Não falha o cadastro se não conseguir vincular como proprietário
      }
    }

  // Handle vehicle creation if provided (suporta array de veículos ou vehicle único para compatibilidade)
  console.log('[DEBUG] create - Received vehicle data:', vehicleInput);
  console.log('[DEBUG] create - Received vehicles data:', vehiclesInput);
  
  // Array de veículos para inserir
  const vehiclesToInsert = [];
  
  // Compatibilidade: se vier 'vehicle' (singular), adicionar ao array
  if (vehicleInput) {
    const { license_plate, brand, model, color, year, parking_id, company_id, spot_number, tag_number } = vehicleInput;
    if (license_plate) {
      vehiclesToInsert.push({ license_plate, brand, model, color, year, parking_id, company_id, spot_number, tag_number });
    }
  }
  
  // Se Vier 'vehicles' (plural), adicionar todos ao array
  if (vehiclesInput && Array.isArray(vehiclesInput)) {
    for (const v of vehiclesInput) {
      if (v.license_plate || v.placa) {
        vehiclesToInsert.push({
          license_plate: v.license_plate || v.placa,
          brand: v.brand || v.marca,
          model: v.model || v.modelo,
          color: v.cor || v.color,
          year: v.ano || v.year,
          parking_id: v.parking_id || v.vagaId,
          company_id: v.company_id || v.empresaId,
          spot_number: v.spot_number || v.vagaInfo,
          tag_number: v.tag_number || v.tagNumero
        });
      }
    }
  }
  
  // Inserir todos os veículos
  for (const v of vehiclesToInsert) {
    if (v.license_plate) {
      // Check for conflicts
      const conflict = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [v.license_plate]);
      if (conflict) {
        console.warn('[DEBUG] create - Vehicle plate already exists:', v.license_plate);
      } else {
        await db.run(
          `INSERT INTO vehicles (person_id, license_plate, brand, model, color, year, parking_id, company_id, spot_number, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [insertedId, v.license_plate, v.brand || null, v.model || null, v.color || null, v.year || null, v.parking_id || null, v.company_id || null, v.spot_number || null, v.tag_number || null]
        );
        console.log('[DEBUG] create - Vehicle inserted for person:', insertedId, v.license_plate);
      }
    }
  }

  const person = await db.get('SELECT * FROM persons WHERE id = ?', [result.lastID]);

  // Adicionar à fila de processamento de faces se tiver foto
  if (person.photo_url) {
    try {
      await addToFaceQueue(db, req.tenantId, person.id, person.name, 'person', person.photo_url);
      console.log(`[faceQueue] Pessoa ${person.id} adicionada à fila de processamento`);
    } catch (queueError) {
      console.warn('[faceQueue] Erro ao adicionar à fila:', queueError);
    }
  }

  // Attach groups and vehicle to return full person payload (so frontend keeps selections)
  await ensurePersonGroupsTable(db);
  const groups = await db.all('SELECT g.id, g.name FROM groups g JOIN person_groups pg ON g.id = pg.group_id WHERE pg.person_id = ?', [person.id]);
  
  // Buscar veículos com informações da empresa (LEFT JOIN)
  const vehicles = await db.all(`
    SELECT v.*, 
           c.corporate_name as company_corporate_name, 
           c.trading_name as company_trading_name
    FROM vehicles v 
    LEFT JOIN companies c ON v.company_id = c.id 
    WHERE v.person_id = ?
  `, [person.id]);
  
  // Adicionar nome da empresa aos veículos
  for (const v of vehicles) {
    v.company_display_name = v.company_corporate_name || v.company_trading_name || (v.company_id ? 'Empresa #' + v.company_id : null);
  }
  
  const vehicle = vehicles.length > 0 ? vehicles[0] : null;
  console.log('[DEBUG] getById - Vehicle from DB for person_id', person.id + ':', vehicle);
  console.log('[DEBUG] getById - All vehicles from DB for person_id', person.id + ':', vehicles);

  res.status(201).json({
    success: true,
    data: formatPersonData({
      ...formatPerson(person),
      vehicle: vehicle || null,
      vehicles: vehicles || [],
      groups: groups || []
    }),
    message: 'Pessoa cadastrada com sucesso'
  });

  // Log audit
  await auditService.logCreate(req, 'person', person.id, `Cadastro de pessoa: ${person.name} (${person.registration_number || 'S/N'})`, person);

  // Push: cada equip recebe o cadastro APENAS se a regra de acesso autorizar.
  // Pessoa nova nunca esteve no equip antes, então onUnauthorized = nada.
  try {
    const photoBase64 = await loadPhotoBase64IfExists(person.photo_url);
    await enqueueForAuthorizedDevices(db, req.tenantId, 'person', person.id, {
      onAuthorized: async (deviceId) => buildPersonRegisterCommands({
        person: { id: person.id, name: person.name, registration_number: person.registration_number },
        tenantId: req.tenantId,
        deviceId,
        photoBase64,
      }),
    });
  } catch (err) {
    console.error('[push enqueue person create]', err.message);
  }

  const qrcodeValue = req.body.qrcode_value || req.body.qrcodeValue || req.body.qrcode;
  if (qrcodeValue) {
    try {
      await enqueueForAuthorizedDevices(db, req.tenantId, 'person', person.id, {
        onAuthorized: async (deviceId) => buildPersonQrCodeCommands({
          person: { id: person.id, registration_number: person.registration_number },
          tenantId: req.tenantId,
          deviceId,
          qrcodeValue
        }),
      });
    } catch (err) {
      console.error('[push enqueue person qrcode create]', err.message);
    }
  }
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  // Extrair vehicle e vehicles do body para não incluir na atualização da tabela persons
  const {
    vehicle: vehicleInput,
    vehicles: vehiclesInput,
    groups: groupsInput,
    password,
    mobile_permissions,
    ...data
  } = req.body;

  console.log('[DEBUG] update - cellphone_ddi:', data.cellphone_ddi);
  
  // Buscar valores antigos para o log de auditoria
  const oldPersonRecord = await db.get('SELECT * FROM persons WHERE id = ?', [id]);
  const oldGroups = await db.all('SELECT group_id FROM person_groups WHERE person_id = ?', [id]);
  const oldVehicles = await db.all('SELECT * FROM vehicles WHERE person_id = ?', [id]);
  
  const oldValues = {
      ...oldPersonRecord,
      groups: oldGroups.map(g => g.group_id),
      vehicles: oldVehicles
  };

  const existing = await db.get('SELECT id FROM persons WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  if (data.cpf && !validateCPF(data.cpf)) {
    return res.status(400).json({
      success: false,
      message: 'CPF inválido'
    });
  }

  // Verificar se novo nome já existe (para outra pessoa)
  if (data.name) {
    const nameConflict = await db.get('SELECT id FROM persons WHERE LOWER(name) = LOWER(?) AND id != ?', [data.name.trim(), id]);
    if (nameConflict) {
      return res.status(400).json({
        success: false,
        message: 'Já existe uma pessoa cadastrada com este nome'
      });
    }
  }

  if (data.cpf) {
    const cpfConflict = await db.get('SELECT id FROM persons WHERE cpf = ? AND id != ?', [data.cpf, id]);
    if (cpfConflict) {
      return res.status(400).json({
        success: false,
        message: 'CPF já cadastrado para outra pessoa'
      });
    }
  }

  if (data.email) {
    if (!validateEmail(data.email)) {
      return res.status(400).json({
        success: false,
        message: 'Email inválido'
      });
    }
    const emailConflict = await db.get('SELECT id FROM persons WHERE email = ? AND id != ?', [data.email, id]);
    if (emailConflict) {
      return res.status(400).json({
        success: false,
        message: 'Email já cadastrado para outra pessoa'
      });
    }
  }

  const fields = [];
  const values = [];
  // Fields that should not be updated directly
  // `foto` e `photo_base64` são tratados separadamente abaixo (processBase64Photo
  // salva o arquivo no disco e atualiza photo_url — não pode cair no loop genérico
  // que faria UPDATE persons SET foto=<base64>, criando coluna inválida).
  const skipFields = [
    'id', 'created_at', 'created_by', 'group_ids', 'groupIds',
    'vehicle', 'vehicles', 'veiculos', 'group_name', 'company_name',
    'nome', 'groups', 'qrcode_value', 'qrcodeValue', 'qrcode_type', 'cartoes',
    'foto', 'photo_base64'
  ];

  Object.keys(data).forEach(key => {
    if (!skipFields.includes(key)) {
      // Mapear 'matricula' do frontend para coluna 'registration_number'
      const column = key === 'matricula' ? 'registration_number' : key;
      fields.push(`${column} = ?`);
      if (column === 'lgpd_consent' && data[key]) {
        values.push(1);
      } else if (column === 'lgpd_consent') {
        values.push(0);
      } else {
        values.push(data[key]);
      }
    }
  });

  if (data.lgpd_consent && !data.consent_date) {
    fields.push('consent_date = ?');
    values.push(new Date().toISOString());
  }

  // Novos campos Mobile
  const tableColumns = await getTableColumns(db, 'persons');
  
  if (password && tableColumns.includes('password_hash')) {
    const hashedPassword = await hashPassword(password);
    fields.push('password_hash = ?');
    values.push(hashedPassword);
  }

  if (mobile_permissions !== undefined && tableColumns.includes('mobile_permissions')) {
    const perms = typeof mobile_permissions === 'string' ? mobile_permissions : JSON.stringify(mobile_permissions);
    fields.push('mobile_permissions = ?');
    values.push(perms);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  // Processar foto nova (se enviada): salva arquivo + atualiza photo_url + extrai embedding.
  // O loop genérico de fields acima pula `foto`/`photo_base64` via skipFields.
  const fotoRaw = data.foto || data.photo_base64 || null;
  const fotoBase64 = (typeof fotoRaw === 'string' && fotoRaw.startsWith('data:image')) ? fotoRaw : null;
  if (fotoBase64 && tableColumns.includes('photo_url')) {
    // Busca foto atual pra deletar depois (só se a nova der sucesso)
    const oldRow = await db.get('SELECT photo_url FROM persons WHERE id = ?', [id]);

    const desiredName = `person_${id}`;
    const processed = await photoService.processBase64Photo(fotoBase64, 'person', desiredName, req.tenantId);
    const newPhotoUrl = processed.url;

    fields.push('photo_url = ?');
    values.splice(values.length - 1, 0, newPhotoUrl); // antes do `id` no final

    if (tableColumns.includes('photo_base64')) {
      fields.push('photo_base64 = ?');
      values.splice(values.length - 1, 0, null);
    }

    // Deletar foto antiga
    if (oldRow?.photo_url && oldRow.photo_url !== newPhotoUrl) {
      try {
        const oldFilename = oldRow.photo_url.split('/').pop().split('?')[0];
        await photoService.deletePhoto(oldFilename, 'person');
      } catch (e) {
        console.warn('[update foto] erro deletando antiga:', e.message);
      }
    }
  }

  // Extrair embedding facial se a foto foi atualizada
  if (fotoBase64) {
    try {
      const { embedding, error } = await extractEmbedding(fotoBase64);
      if (embedding && !error) {
        fields.push('face_embedding = ?');
        values.splice(values.length - 1, 0, JSON.stringify(embedding));
      }
    } catch (embedError) {
      console.warn('Erro ao extrair embedding facial:', embedError);
    }
  }

  await db.run(
    `UPDATE persons SET ${fields.join(', ')} WHERE id = ?`,
    values
  );

  // If groups provided in update payload, replace associations
  // Use Array.isArray to handle both empty arrays and null/undefined
  if (Array.isArray(data.group_ids) || Array.isArray(data.groupIds)) {
    const newGroups = (Array.isArray(data.group_ids) ? data.group_ids : data.groupIds) || [];
    await ensurePersonGroupsTable(db);
    await db.run('DELETE FROM person_groups WHERE person_id = ?', [id]);
    for (const gid of newGroups) {
      await db.run('INSERT OR IGNORE INTO person_groups (person_id, group_id, created_at) VALUES (?, ?, ?)', [id, gid, new Date().toISOString()]);
    }
    // update primary group on persons table
    await db.run('UPDATE persons SET group_id = ? WHERE id = ?', [newGroups[0] || null, id]);
  }

  // Vincular pessoa como proprietária da empresa (se company_id for alterado)
  const companyId = data.company_id || null;
  if (companyId !== null) {
    try {
      // Primeiro, buscar a empresa anterior da pessoa
      const person = await db.get('SELECT company_id FROM persons WHERE id = ?', [id]);
      const oldCompanyId = person?.company_id;
      
      // Se a empresa mudou, atualizar os proprietários
      if (oldCompanyId !== companyId) {
        // Remover vínculo com a empresa anterior (se existir)
        if (oldCompanyId) {
          await db.run(
            'DELETE FROM company_owners WHERE company_id = ? AND person_id = ?',
            [oldCompanyId, id]
          );
        }
        
        // Adicionar vínculo com a nova empresa (se existir)
        if (companyId) {
          const existingOwner = await db.get(
            'SELECT id FROM company_owners WHERE company_id = ? AND person_id = ?',
            [companyId, id]
          );
          if (!existingOwner) {
            await db.run(
              'INSERT INTO company_owners (company_id, person_id) VALUES (?, ?)',
              [companyId, id]
            );
            console.log(`Pessoa ${id} vinculada como proprietária da empresa ${companyId}`);
          }
        }
      }
    } catch (ownerError) {
      console.warn('Erro ao atualizar vínculo de proprietário:', ownerError);
    }
  }

  // Handle vehicle update if provided (suporta array de veículos ou vehicle único para compatibilidade)
  console.log('[DEBUG] update - Received vehicle data:', vehicleInput);
  console.log('[DEBUG] update - Received vehicles data:', vehiclesInput);
  
  // Array de veículos para atualizar
  const vehiclesToUpdate = [];
  
  // Compatibilidade: se vier 'vehicle' (singular), adicionar ao array
  if (vehicleInput && (vehicleInput.license_plate || vehicleInput.placa)) {
    vehiclesToUpdate.push({
      license_plate: vehicleInput.license_plate || vehicleInput.placa,
      brand: vehicleInput.brand || vehicleInput.marca,
      model: vehicleInput.model || vehicleInput.modelo,
      color: vehicleInput.cor || vehicleInput.color,
      year: vehicleInput.ano || vehicleInput.year,
      parking_id: vehicleInput.parking_id || vehicleInput.vagaId,
      company_id: vehicleInput.company_id || vehicleInput.empresaId,
      spot_number: vehicleInput.spot_number || vehicleInput.vagaInfo,
      tag_number: vehicleInput.tag_number || vehicleInput.tagNumero
    });
  }
  
  // Se vier 'vehicles' (plural), adicionar todos ao array
  if (vehiclesInput && Array.isArray(vehiclesInput)) {
    for (const v of vehiclesInput) {
      if (v.license_plate || v.placa) {
        vehiclesToUpdate.push({
          license_plate: v.license_plate || v.placa,
          brand: v.brand || v.marca,
          model: v.model || v.modelo,
          color: v.cor || v.color,
          year: v.ano || v.year,
          parking_id: v.parking_id || v.vagaId,
          company_id: v.company_id || v.empresaId,
          spot_number: v.spot_number || v.vagaInfo,
          tag_number: v.tag_number || v.tagNumero
        });
      }
    }
  }
  
  // Se veio explicitamente null ou array vazio, excluir todos os veículos
  if (vehicleInput === null || vehiclesInput === null || (Array.isArray(vehiclesInput) && vehiclesInput.length === 0)) {
    await db.run('DELETE FROM vehicles WHERE person_id = ?', [id]);
    console.log('[DEBUG] update - All vehicles deleted for person_id:', id);
  } else if (vehiclesToUpdate.length > 0) {
    // Primeiro excluir todos os veículos existentes
    await db.run('DELETE FROM vehicles WHERE person_id = ?', [id]);
    console.log('[DEBUG] update - Existing vehicles deleted for person_id:', id);
    
    // Depois inserir todos os veículos novos
    for (const v of vehiclesToUpdate) {
      if (v.license_plate) {
        // Check for conflicts with other people's vehicles
        const conflict = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [v.license_plate]);
        if (conflict) {
          console.warn('[DEBUG] update - Vehicle plate already exists for another person:', v.license_plate);
          // Não lança erro, apenas pula esse veículo
        } else {
          await db.run(
            `INSERT INTO vehicles (person_id, license_plate, brand, model, color, year, parking_id, company_id, spot_number, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, v.license_plate, v.brand || null, v.model || null, v.color || null, v.year || null, v.parking_id || null, v.company_id || null, v.spot_number || null, v.tag_number || null]
          );
          console.log('[DEBUG] update - Vehicle inserted/updated for person_id:', id, v.license_plate);
        }
      }
    }
  }

  const person = await db.get('SELECT * FROM persons WHERE id = ?', [id]);

  // Adicionar à fila de processamento de faces se tiver foto
  if (person.photo_url) {
    try {
      await addToFaceQueue(db, req.tenantId, person.id, person.name, 'person', person.photo_url);
      console.log(`[faceQueue] Pessoa ${person.id} atualizada e adicionada à fila de processamento`);
    } catch (queueError) {
      console.warn('[faceQueue] Erro ao adicionar à fila:', queueError);
    }
  }

  // Return full person payload including groups and vehicle so frontend preserves selections
  await ensurePersonGroupsTable(db);
  const groups = await db.all('SELECT g.id, g.name FROM groups g JOIN person_groups pg ON g.id = pg.group_id WHERE pg.person_id = ?', [id]);
  
  // Buscar veículos com informações da empresa (LEFT JOIN)
  const vehicles = await db.all(`
    SELECT v.*, 
           c.corporate_name as company_corporate_name, 
           c.trading_name as company_trading_name
    FROM vehicles v 
    LEFT JOIN companies c ON v.company_id = c.id 
    WHERE v.person_id = ?
  `, [id]);
  
  // Adicionar nome da empresa aos veículos
  for (const v of vehicles) {
    v.company_display_name = v.company_corporate_name || v.company_trading_name || (v.company_id ? 'Empresa #' + v.company_id : null);
  }
  
  const vehicle = vehicles.length > 0 ? vehicles[0] : null;

  res.json({
    success: true,
    data: formatPersonData({
      ...formatPerson(person),
      vehicle: vehicle || null,
      vehicles: vehicles || [],
      groups: groups || []
    }),
    message: 'Pessoa atualizada com sucesso'
  });

  // Log audit
  const newValues = {
      ...person,
      groups: groups.map(g => g.id),
      vehicles: vehicles
  };
  await auditService.logUpdate(req, 'person', id, `Atualização de pessoa: ${person.name} (${person.registration_number || 'S/N'})`, oldValues, newValues);

  // Push: update pode ter mudado grupo/empresa da pessoa, então a autorização
  // por equipamento pode ter mudado. Cada equip ou recebe upsert OU destroy.
  try {
    const photoBase64 = await loadPhotoBase64IfExists(person.photo_url);
    const equipUserId = toDeviceUserId('person', person.id, person.registration_number);
    await enqueueForAuthorizedDevices(db, req.tenantId, 'person', person.id, {
      onAuthorized: async (deviceId) => buildPersonRegisterCommands({
        person: { id: person.id, name: person.name, registration_number: person.registration_number },
        tenantId: req.tenantId,
        deviceId,
        photoBase64,
      }),
      onUnauthorized: async (deviceId) => [{
        deviceId,
        origin: `person:update:unauthorized:${person.id}`,
        endpoint: 'destroy_objects',
        body: { object: 'users', where: { users: { id: equipUserId } } },
      }],
    });
  } catch (err) {
    console.error('[push enqueue person update]', err.message);
  }

  const qrcodeValue = req.body.qrcode_value || req.body.qrcodeValue || req.body.qrcode;
  if (qrcodeValue) {
    try {
      await enqueueForAuthorizedDevices(db, req.tenantId, 'person', person.id, {
        onAuthorized: async (deviceId) => buildPersonQrCodeCommands({
          person: { id: person.id, registration_number: person.registration_number },
          tenantId: req.tenantId,
          deviceId,
          qrcodeValue
        }),
        // QR sem autorização não enfileira nada — o destroy do user (acima) já
        // removeu a pessoa toda do equip, qrcode some junto.
      });
    } catch (err) {
      console.error('[push enqueue person qrcode update]', err.message);
    }
  }
});

export const generateRandomMatricula = asyncHandler(async (req, res) => {
  const db = req.db;
  const matricula = await generateUniqueRandomRegistrationNumber(db);
  
  if (!matricula) {
    return res.status(400).json({
      success: false,
      message: 'Não foi possível gerar matrícula. Verifique se o campo existe no banco de dados.'
    });
  }

  res.json({
    success: true,
    data: matricula
  });
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  const person = await db.get('SELECT id, status, photo_url, name, registration_number FROM persons WHERE id = ?', [id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  // Se já estiver inativo, fazer exclusão permanente
  if (person.status === 'inactive') {
    return res.status(400).json({
      success: false,
      message: 'Pessoa já está inativa. Use a exclusão permanente.'
    });
  }

  // Deletar foto se existir
  if (person.photo_url) {
    const filename = person.photo_url.split('/').pop();
    await photoService.deletePhoto(filename, 'person');
  }

  // Remover da fila de processamento de faces
  try {
    await db.run('DELETE FROM face_queue WHERE person_id = ? AND person_type = ?', [id, 'person']);
    console.log(`[faceQueue] Pessoa ${id} removida da fila`);
  } catch (queueError) {
    console.warn('[faceQueue] Erro ao remover da fila:', queueError);
  }

  // Inativar a pessoa (soft delete)
  await db.run(
    'UPDATE persons SET status = ?, updated_at = ? WHERE id = ?',
    ['inactive', new Date().toISOString(), id]
  );

  // Criar tarefa de exclusão da pessoa no equipamento (para o comunicador).
  // target_id PRECISA ser o id interno (persons.id) — é o que o comunicador
  // grava como `id` do usuário no equipamento ControlID. Usar a matrícula
  // (registration_number) aqui faz o destroy {id|registration} falhar nos 3
  // fallbacks do _excluir_usuario_equipamento e deixa usuário órfão, gerando
  // duplicata quando a pessoa é recadastrada com novo id interno.
  try {
    await db.run(
      `INSERT INTO access_tasks
       (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
       VALUES (?, 'delete_person', 'person', ?, 'pending', datetime('now'), ?, 'all')`,
      [tenantId, id, `Inativação de pessoa: ${person.name || id}`]
    );
  } catch (taskError) {
    console.warn('[remove] Erro ao criar tarefa de exclusão:', taskError);
  }

  res.json({
    success: true,
    message: 'Pessoa removida com sucesso'
  });

  // Log audit
  await auditService.logDelete(req, 'person', id, `Inativação de pessoa: ${person.name} (${person.registration_number || 'S/N'})`, person);

  // Inativar = remover do equipamento. Usa MATRÍCULA (compat. com Comunicador).
  try {
    const equipUserId = toDeviceUserId('person', id, person.registration_number);
    await enqueueForActiveDevices(db, req.tenantId, async (deviceId) => [{
      deviceId,
      origin: `person:inactivate:${id}`,
      endpoint: 'destroy_objects',
      body: { object: 'users', where: { users: { id: equipUserId } } },
    }]);
  } catch (err) {
    console.error('[push enqueue person inactivate]', err.message);
  }
});

// Ativar pessoa (mudar status de inactive para active)
export const activate = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  const person = await db.get('SELECT id, status, name, registration_number FROM persons WHERE id = ?', [id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  if (person.status === 'active') {
    return res.status(400).json({
      success: false,
      message: 'Pessoa já está ativa'
    });
  }

  // Ativar a pessoa
  await db.run(
    'UPDATE persons SET status = ?, updated_at = ? WHERE id = ?',
    ['active', new Date().toISOString(), id]
  );

  // Criar tarefa de sincronização da pessoa no equipamento.
  // target_id = id interno (persons.id) — mesma justificativa do delete_person:
  // o comunicador faz lookup por id no equipamento, não pela matrícula.
  await db.run(
    `INSERT INTO access_tasks
     (tenant_id, task_type, target_type, target_id, status, created_at, description, equip_validator)
     VALUES (?, 'sync_person', 'person', ?, 'pending', datetime('now'), ?, 'all')`,
    [tenantId, id, `Ativação de pessoa: ${person.name || id}`]
  );

  res.json({
    success: true,
    message: 'Pessoa ativada com sucesso'
  });

  // Reativar = recadastrar nos equipamentos AUTORIZADOS pela regra.
  try {
    const fullPerson = await db.get('SELECT id, name, photo_url, registration_number FROM persons WHERE id = ?', [id]);
    const photoBase64 = await loadPhotoBase64IfExists(fullPerson?.photo_url);
    await enqueueForAuthorizedDevices(db, req.tenantId, 'person', fullPerson.id, {
      onAuthorized: async (deviceId) => buildPersonRegisterCommands({
        person: fullPerson,
        tenantId: req.tenantId,
        deviceId,
        photoBase64,
      }),
    });
  } catch (err) {
    console.error('[push enqueue person activate]', err.message);
  }

  // Log audit
  await auditService.logAction({
      req,
      action: 'UPDATE',
      entity_type: 'person',
      entity_id: id,
      description: `Ativação de pessoa: ${person.name} (${person.registration_number || 'S/N'})`,
      new_values: { status: 'active' }
  });
});

// Exclusão permanente de pessoa (apenas para registros inativos)
export const forceDelete = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;

  const person = await db.get('SELECT id, status, photo_url, name FROM persons WHERE id = ?', [id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  if (person.status !== 'inactive') {
    return res.status(400).json({
      success: false,
      message: 'Apenas pessoas inativas podem ser excluídas permanentemente. Use o endpoint de remoção padrão.'
    });
  }

  // Deletar foto se existir
  if (person.photo_url) {
    const filename = person.photo_url.split('/').pop();
    try {
      await photoService.deletePhoto(filename, 'person');
    } catch (e) {
      console.warn('[forceDelete] Erro ao deletar foto:', e);
    }
  }

  // Remover da fila de processamento de faces
  try {
    await db.run('DELETE FROM face_queue WHERE person_id = ? AND person_type = ?', [id, 'person']);
  } catch (queueError) {
    console.warn('[forceDelete] Erro ao remover da fila:', queueError);
  }

  // Remover relações com grupos
  try {
    await db.run('DELETE FROM person_groups WHERE person_id = ?', [id]);
  } catch (e) {
    console.warn('[forceDelete] Erro ao remover grupos:', e);
  }

  // Remover veículos associados
  try {
    await db.run('DELETE FROM vehicles WHERE person_id = ?', [id]);
  } catch (e) {
    console.warn('[forceDelete] Erro ao remover veículos:', e);
  }

  // Excluir definitivamente a pessoa
  await db.run('DELETE FROM persons WHERE id = ?', [id]);

  res.json({
    success: true,
    message: 'Pessoa excluída permanentemente'
  });

  // Log audit
  await auditService.logDelete(req, 'person', id, `Exclusão permanente de pessoa: ${person.name} (${person.registration_number || 'S/N'})`, person);

  // Enfileira destroy_objects no push_outbox para equipamentos modo push
  try {
    await enqueueForActiveDevices(db, req.tenantId, async (deviceId) => [{
      deviceId,
      origin: `person:delete:${id}`,
      endpoint: 'destroy_objects',
      body: {
        object: 'users',
        where: { users: { id: parseInt(id, 10) } },
      },
    }]);
  } catch (err) {
    console.error('[push enqueue person delete]', err.message);
  }
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

  const person = await db.get('SELECT id, photo_url, name FROM persons WHERE id = ?', [id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  // Deletar foto anterior se existir
  if (person.photo_url) {
    const filename = person.photo_url.split('/').pop();
    await photoService.deletePhoto(filename, 'person');
  }

  // Usar ID do banco como nome do arquivo para garantir unicidade (evita colisão entre pessoas)
  const desiredName = `person_${id}`;

  // Processar e salvar a foto usando tenant_id + ID da pessoa como nome de arquivo
  const processed = await photoService.processPhoto(req.file, 'person', desiredName, tenantId);
  const photoUrl = processed.url;

  const tableColumns = await getTableColumns(db, 'persons');
  const now = new Date().toISOString();
  if (tableColumns.includes('photo_base64')) {
    await db.run(
      'UPDATE persons SET photo_url = ?, photo_base64 = NULL, updated_at = ? WHERE id = ?',
      [photoUrl, now, id]
    );
  } else {
    await db.run(
      'UPDATE persons SET photo_url = ?, updated_at = ? WHERE id = ?',
      [photoUrl, now, id]
    );
  }

  // Adicionar à fila de processamento de faces
  try {
    await addToFaceQueue(db, tenantId, id, person.name, 'person', photoUrl);
    console.log(`[faceQueue] Pessoa ${id} adicionada à fila após upload de foto`);
  } catch (queueError) {
    console.warn('[faceQueue] Erro ao adicionar à fila:', queueError);
  }

  res.json({
    success: true,
    data: { photo_url: photoUrl },
    message: 'Foto enviada com sucesso'
  });
});

export const getVehicle = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const vehicle = await db.get('SELECT * FROM vehicles WHERE person_id = ?', [id]);

  res.json({
    success: true,
    data: vehicle || null
  });
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { license_plate, brand, model, color, year } = req.body;

  if (!license_plate) {
    return res.status(400).json({
      success: false,
      message: 'Placa é obrigatória'
    });
  }

  const person = await db.get('SELECT id FROM persons WHERE id = ?', [id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  const existing = await db.get('SELECT id FROM vehicles WHERE person_id = ?', [id]);

  // Se é um novo veículo (não exists), validar limite
  if (!existing) {
    const limits = await getTenantLimits(db);
    const currentCount = await countVehicles(db);
    if (currentCount >= limits.max_equipamentos) {
      return res.status(429).json({
        success: false,
        message: `Limite de equipamentos/veículos (${limits.max_equipamentos}) atingido para este tenant`,
        current: currentCount,
        limit: limits.max_equipamentos
      });
    }
  }

  if (existing) {
    const conflict = await db.get('SELECT id FROM vehicles WHERE license_plate = ? AND person_id != ?', [license_plate, id]);
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'Placa já cadastrada'
      });
    }

    await db.run(
      `UPDATE vehicles SET license_plate = ?, brand = ?, model = ?, color = ?, year = ?
       WHERE person_id = ?`,
      [license_plate, brand || null, model || null, color || null, year || null, id]
    );
  } else {
    const conflict = await db.get('SELECT id FROM vehicles WHERE license_plate = ?', [license_plate]);
    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'Placa já cadastrada'
      });
    }

    await db.run(
      `INSERT INTO vehicles (person_id, license_plate, brand, model, color, year)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, license_plate, brand || null, model || null, color || null, year || null]
    );
  }

  const vehicle = await db.get('SELECT * FROM vehicles WHERE person_id = ?', [id]);

  res.json({
    success: true,
    data: vehicle,
    message: 'Veículo atualizado com sucesso'
  });
});

export const getStats = asyncHandler(async (req, res) => {
  const db = req.db;

  const total = await db.get('SELECT COUNT(*) as count FROM persons');
  const active = await db.get("SELECT COUNT(*) as count FROM persons WHERE status = 'active'");
  const inactive = await db.get("SELECT COUNT(*) as count FROM persons WHERE status = 'inactive'");

  res.json({
    success: true,
    data: {
      total: total.count,
      active: active.count,
      inactive: inactive.count
    }
  });
});




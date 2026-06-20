import { formatCompany } from '../utils/formatters.js';
import { validateCNPJ, validateEmail } from '../utils/validators.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 10, active, search } = req.query;
  
  // Permitir limite maior para busca de todas as empresas (filtragem local)
  const parsedLimit = Math.min(parseInt(limit) || 10, 10000);
  const offset = (page - 1) * parsedLimit;

  let query = 'SELECT * FROM companies WHERE 1=1';
  const params = [];

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  if (search) {
    query += ' AND (corporate_name LIKE ? OR trading_name LIKE ? OR cnpj LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  query += ' ORDER BY corporate_name ASC LIMIT ? OFFSET ?';
  params.push(parsedLimit, offset);

  const companies = await db.all(query, params);

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: companies.map(formatCompany),
    pagination: {
      page: parseInt(page),
      limit: parsedLimit,
      total: total,
      totalPages: Math.ceil(total / parsedLimit)
    }
  });
});

export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const company = await db.get('SELECT * FROM companies WHERE id = ?', [id]);

  if (!company) {
    return res.status(404).json({
      success: false,
      message: 'Empresa não encontrada'
    });
  }

  // Buscar proprietários da empresa (da tabela company_owners E pessoas com company_id setado)
  const explicitOwners = await db.all(
    `SELECT p.id, p.name, p.cpf, p.email
     FROM company_owners co
     JOIN persons p ON co.person_id = p.id
     WHERE co.company_id = ?`,
    [id]
  );

  // Buscar pessoas que têm company_id setado diretamente (vinculadas automaticamente)
  const linkedPersons = await db.all(
    `SELECT p.id, p.name, p.cpf, p.email
     FROM persons p
     WHERE p.company_id = ?`,
    [id]
  );

  // Mesclar e remover duplicatas
  const ownersMap = new Map();
  explicitOwners.forEach(o => ownersMap.set(o.id, o));
  linkedPersons.forEach(p => {
    if (!ownersMap.has(p.id)) {
      ownersMap.set(p.id, p);
    }
  });
  const owners = Array.from(ownersMap.values());

  // Buscar grupos da nova tabela company_groups
  const groups = await db.all(
    `SELECT g.id, g.name, g.type, g.description
     FROM company_groups cg
     JOIN groups g ON cg.group_id = g.id
     WHERE cg.company_id = ?`,
    [id]
  );

  // Buscar e-mails de notificação
  const notificationEmails = await db.all(
    'SELECT email FROM company_notification_emails WHERE company_id = ?',
    [id]
  );
  const notification_emails = notificationEmails.map(e => e.email);

  // Also get group_id from companies table for backwards compatibility
  const companyGroupId = company.group_id;

  res.json({
    success: true,
    data: {
      ...formatCompany(company),
      owners,
      groups,
      group_id: companyGroupId,
      notification_emails
    }
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const { corporate_name, cnpj, trading_name, phone, email, address, group_ids, notification_emails } = req.body;

  if (!corporate_name) {
    return res.status(400).json({
      success: false,
      message: 'Razão social é obrigatória'
    });
  }

  if (email && !validateEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Email inválido'
    });
  }

  if (cnpj) {
    const existing = await db.get('SELECT id FROM companies WHERE cnpj = ?', [cnpj]);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'CNPJ já cadastrado'
      });
    }
  }

  // Verificar se a coluna group_id existe na tabela companies
  let hasGroupId = false;
  try {
    const tableInfo = await db.all("PRAGMA table_info(companies)");
    hasGroupId = tableInfo.some(col => col.name === 'group_id');
    // Se não existir, criar a coluna
    if (!hasGroupId) {
      await db.run('ALTER TABLE companies ADD COLUMN group_id INTEGER REFERENCES groups(id)');
      hasGroupId = true;
    }
  } catch (e) {
    console.warn('Erro ao verificar/criar coluna group_id:', e);
  }

  // Usar o primeiro grupo do array como group_id para compatibilidade com tabela companies
  const primaryGroupId = Array.isArray(group_ids) && group_ids.length > 0 ? group_ids[0] : null;
  
  const result = await db.run(
    'INSERT INTO companies (corporate_name, trading_name, cnpj, phone, email, address, created_by, active, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [corporate_name, trading_name || null, cnpj, phone || null, email || null, address || null, req.user.id, 1, primaryGroupId]
  );

  const company = await db.get('SELECT * FROM companies WHERE id = ?', [result.lastID]);

  // Salvar grupos adicionais na tabela company_groups
  if (Array.isArray(group_ids) && group_ids.length > 0) {
    for (const groupId of group_ids) {
      if (groupId) {
        await db.run(
          'INSERT INTO company_groups (company_id, group_id, created_by) VALUES (?, ?, ?)',
          [company.id, groupId, req.user.id]
        );
      }
    }
  }

  // Salvar e-mails de notificação
  if (Array.isArray(notification_emails) && notification_emails.length > 0) {
    for (const email of notification_emails) {
      if (email && email.trim()) {
        await db.run(
          'INSERT INTO company_notification_emails (company_id, email) VALUES (?, ?)',
          [company.id, email.trim()]
        );
      }
    }
  }

  res.status(201).json({ success: true, data: formatCompany(company), message: 'Empresa criada com sucesso' });
  await auditService.logCreate(req, { entityType: 'company', entityId: company.id, description: `Empresa criada: ${company.corporate_name} (CNPJ: ${company.cnpj || 'S/N'})`, newData: company });
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const data = req.body;
  
  console.log('Dados recebidos para update company:', data);

  // Verificar se a coluna group_id existe na tabela companies
  let hasGroupId = false;
  try {
    const tableInfo = await db.all("PRAGMA table_info(companies)");
    hasGroupId = tableInfo.some(col => col.name === 'group_id');
    // Se não existir, criar a coluna
    if (!hasGroupId) {
      await db.run('ALTER TABLE companies ADD COLUMN group_id INTEGER REFERENCES groups(id)');
      hasGroupId = true;
    }
  } catch (e) {
    console.warn('Erro ao verificar/criar coluna group_id:', e);
  }

  const oldCompany = await db.get('SELECT * FROM companies WHERE id = ?', [id]);
  if (!oldCompany) {
    return res.status(404).json({
      success: false,
      message: 'Empresa não encontrada'
    });
  }

  if (data.cnpj) {
    const existing = await db.get('SELECT id FROM companies WHERE cnpj = ? AND id != ?', [data.cnpj, id]);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'CNPJ já cadastrado para outra empresa'
      });
    }
  }

  if (data.email && !validateEmail(data.email)) {
    return res.status(400).json({
      success: false,
      message: 'Email inválido'
    });
  }

  const fields = [];
  const values = [];
  
  const skipFields = ['id', 'created_at', 'created_by', 'group_ids', 'groupIds', 'gruposNomes', 'group_id', 'groups', 'owners', 'notification_emails'];

  Object.keys(data).forEach(key => {
    if (!skipFields.includes(key)) {
      fields.push(`${key} = ?`);
      if (key === 'active') {
        values.push(data[key] ? 1 : 0);
      } else {
        values.push(data[key]);
      }
    }
  });

  if (fields.length > 0) {
    values.push(id);
    await db.run(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  // Atualizar grupos
  if (data.group_ids && Array.isArray(data.group_ids)) {
    await db.run('DELETE FROM company_groups WHERE company_id = ?', [id]);
    for (const groupId of data.group_ids) {
      if (groupId) {
        await db.run(
          'INSERT INTO company_groups (company_id, group_id, created_by) VALUES (?, ?, ?)',
          [id, groupId, req.user.id]
        );
      }
    }
  }

  // Atualizar e-mails de notificação
  if (data.notification_emails !== undefined && Array.isArray(data.notification_emails)) {
    await db.run('DELETE FROM company_notification_emails WHERE company_id = ?', [id]);
    for (const email of data.notification_emails) {
      if (email && email.trim()) {
        await db.run(
          'INSERT INTO company_notification_emails (company_id, email) VALUES (?, ?)',
          [id, email.trim()]
        );
      }
    }
  }

  const updatedCompany = await db.get('SELECT * FROM companies WHERE id = ?', [id]);

  res.json({ success: true, data: formatCompany(updatedCompany), message: 'Empresa atualizada com sucesso' });
  await auditService.logUpdate(req, { entityType: 'company', entityId: id, description: `Empresa atualizada: ${updatedCompany.corporate_name}`, oldData: oldCompany, newData: updatedCompany });
});

export const addOwner = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { person_id } = req.body;

  if (!person_id) {
    return res.status(400).json({
      success: false,
      message: 'ID da pessoa é obrigatório'
    });
  }

  const company = await db.get('SELECT id FROM companies WHERE id = ?', [id]);
  if (!company) {
    return res.status(404).json({
      success: false,
      message: 'Empresa não encontrada'
    });
  }

  const person = await db.get('SELECT id FROM persons WHERE id = ?', [person_id]);
  if (!person) {
    return res.status(404).json({
      success: false,
      message: 'Pessoa não encontrada'
    });
  }

  const existing = await db.get(
    'SELECT id FROM company_owners WHERE company_id = ? AND person_id = ?',
    [id, person_id]
  );
  if (existing) {
    return res.status(400).json({
      success: false,
      message: 'Pessoa já é proprietária desta empresa'
    });
  }

  await db.run(
    'INSERT INTO company_owners (company_id, person_id) VALUES (?, ?)',
    [id, person_id]
  );

  res.status(201).json({
    success: true,
    message: 'Proprietário adicionado com sucesso'
  });
});

export const removeOwner = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id, personId } = req.params;

  await db.run(
    'DELETE FROM company_owners WHERE company_id = ? AND person_id = ?',
    [id, personId]
  );

  res.json({
    success: true,
    message: 'Proprietário removido com sucesso'
  });
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { hard } = req.query;

  const company = await db.get('SELECT id FROM companies WHERE id = ?', [id]);
  if (!company) {
    return res.status(404).json({ success: false, message: 'Empresa não encontrada' });
  }

  if (hard === 'true') {
    await db.run('DELETE FROM company_owners WHERE company_id = ?', [id]);
    await db.run('DELETE FROM companies WHERE id = ?', [id]);
    res.json({ success: true, message: 'Empresa excluída permanentemente' });
    await auditService.logDelete(req, { entityType: 'company', entityId: id, description: `Empresa excluída permanentemente (ID: ${id})`, oldData: company });
  } else {
    await db.run('UPDATE companies SET active = 0 WHERE id = ?', [id]);
    res.json({ success: true, message: 'Empresa inativada com sucesso' });
    await auditService.logAction(req, { action: 'INACTIVATE', entityType: 'company', entityId: id, description: `Empresa inativada (ID: ${id})` });
  }
});

export const restore = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const company = await db.get('SELECT id FROM companies WHERE id = ?', [id]);
  if (!company) {
    return res.status(404).json({ success: false, message: 'Empresa não encontrada' });
  }

  await db.run('UPDATE companies SET active = 1 WHERE id = ?', [id]);
  res.json({ success: true, message: 'Empresa reativada com sucesso' });
  await auditService.logAction(req, { action: 'ACTIVATE', entityType: 'company', entityId: id, description: `Empresa reativada (ID: ${id})` });
});

export const getOwners = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const company = await db.get('SELECT id FROM companies WHERE id = ?', [id]);
  if (!company) {
    return res.status(404).json({ success: false, message: 'Empresa não encontrada' });
  }

  const explicitOwners = await db.all(
    `SELECT p.id, p.name, p.cpf, p.email
     FROM company_owners co
     JOIN persons p ON co.person_id = p.id
     WHERE co.company_id = ?`,
    [id]
  );

  const linkedPersons = await db.all(
    `SELECT p.id, p.name, p.cpf, p.email
     FROM persons p
     WHERE p.company_id = ?`,
    [id]
  );

  const ownersMap = new Map();
  explicitOwners.forEach(o => ownersMap.set(o.id, o));
  linkedPersons.forEach(p => {
    if (!ownersMap.has(p.id)) {
      ownersMap.set(p.id, p);
    }
  });
  const owners = Array.from(ownersMap.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  res.json({
    success: true,
    data: owners
  });
});

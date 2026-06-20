import { formatGroup } from '../utils/formatters.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 10, active, type } = req.query;
  const offset = (page - 1) * limit;

  console.log('[DEBUG groups.list] Requisição recebida - page:', page, 'limit:', limit, 'active:', active, 'type:', type);

  let query = 'SELECT * FROM groups WHERE 1=1';
  const params = [];

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const groups = await db.all(query, params);

  console.log('[DEBUG groups.list] Grupos encontrados no banco:', groups.length);
  console.log('[DEBUG groups.list] Primeiros grupos:', JSON.stringify(groups.slice(0, 3)));

  // Enrich groups with person count
  const enrichedGroups = await Promise.all(
    groups.map(async (group) => {
      const countResult = await db.get(
        `SELECT COUNT(*) as person_count FROM person_groups WHERE group_id = ?`,
        [group.id]
      );
      return {
        ...formatGroup(group),
        person_count: countResult ? countResult.person_count : 0
      };
    })
  );

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: enrichedGroups,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const oldGroup = await db.get('SELECT * FROM groups WHERE id = ?', [id]);
  const group = oldGroup;
  
  console.log('Grupo getById - dados do banco:', group);

  if (!group) {
    return res.status(404).json({
      success: false,
      message: 'Grupo não encontrado'
    });
  }

  // Get person count for this group
  const countResult = await db.get(
    `SELECT COUNT(*) as person_count FROM person_groups WHERE group_id = ?`,
    [id]
  );
  
  const formattedGroup = formatGroup(group);
  console.log('Grupo getById - dados formatados:', formattedGroup);

  res.json({
    success: true,
    data: {
      ...formattedGroup,
      person_count: countResult ? countResult.person_count : 0
    }
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const { name, type, description } = req.body;
  
  console.log('Grupo - dados recebidos:', { name, type, description });

  if (!name) {
    return res.status(400).json({
      success: false,
      message: 'Nome é obrigatório'
    });
  }

  const existing = await db.get('SELECT id FROM groups WHERE name = ?', [name]);
  if (existing) {
    return res.status(400).json({
      success: false,
      message: 'Grupo com este nome já existe'
    });
  }

  const result = await db.run(
    'INSERT INTO groups (name, type, description, created_by, active) VALUES (?, ?, ?, ?, ?)',
    [name, type || 'other', description || null, req.user.id, 1]
  );

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [result.lastID]);
  console.log('Grupo - salvo no banco:', group);

  res.status(201).json({
    success: true,
    data: formatGroup(group),
    message: 'Grupo criado com sucesso'
  });
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, type, description, active } = req.body;
  
  console.log('Grupo update - dados recebidos:', { id, name, type, description });

  const group = await db.get('SELECT id FROM groups WHERE id = ?', [id]);
  if (!group) {
    return res.status(404).json({
      success: false,
      message: 'Grupo não encontrado'
    });
  }

  if (name) {
    const existing = await db.get('SELECT id FROM groups WHERE name = ? AND id != ?', [name, id]);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Grupo com este nome já existe'
      });
    }
  }

  const fields = [];
  const values = [];

  if (name) {
    fields.push('name = ?');
    values.push(name);
  }
  if (type !== undefined) {
    fields.push('type = ?');
    values.push(type);
  }
  if (description !== undefined) {
    fields.push('description = ?');
    values.push(description);
  }
  if (active !== undefined) {
    fields.push('active = ?');
    values.push(active ? 1 : 0);
  }

  if (fields.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum campo para atualizar'
    });
  }

  values.push(id);
  await db.run(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`, values);

  const updatedGroup = await db.get('SELECT * FROM groups WHERE id = ?', [id]);
  console.log('Grupo update - dados atualizados no banco:', updatedGroup);

  res.json({
    success: true,
    data: formatGroup(updatedGroup),
    message: 'Grupo atualizado com sucesso'
  });
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const group = await db.get('SELECT id FROM groups WHERE id = ?', [id]);
  if (!group) {
    return res.status(404).json({
      success: false,
      message: 'Grupo não encontrado'
    });
  }

  const personsCount = await db.get('SELECT COUNT(*) as count FROM person_groups WHERE group_id = ?', [id]);
  if (personsCount.count > 0) {
    return res.status(400).json({
      success: false,
      message: 'Não é possível excluir grupo que possui pessoas cadastradas'
    });
  }

  await db.run('DELETE FROM groups WHERE id = ?', [id]);

  res.json({ success: true, message: 'Grupo excluído com sucesso' });
  await auditService.logDelete(req, { entityType: 'group', entityId: id, description: `Grupo excluído (ID: ${id})` });
});




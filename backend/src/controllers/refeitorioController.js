import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 50, search } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM refeitorios WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND (nome LIKE ? OR local LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
  }

  query += ' ORDER BY nome ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const refeitorios = await db.all(query, params);

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  // Format response for frontend
  const formattedRefeitorios = refeitorios.map(r => ({
    id: r.id,
    nome: r.nome,
    local: r.local,
    capacidade: r.capacidade,
    tipo: r.tipo,
    horarioAbertura: r.horario_abertura,
    horarioFechamento: r.horario_fechamento,
    observacoes: r.observacoes
  }));

  res.json({
    success: true,
    data: formattedRefeitorios,
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

  const refeitorio = await db.get('SELECT * FROM refeitorios WHERE id = ?', [id]);

  if (!refeitorio) {
    return res.status(404).json({
      success: false,
      message: 'Refeitório não encontrado'
    });
  }

  res.json({
    success: true,
    data: {
      id: refeitorio.id,
      nome: refeitorio.nome,
      local: refeitorio.local,
      capacidade: refeitorio.capacidade,
      tipo: refeitorio.tipo,
      horarioAbertura: refeitorio.horario_abertura,
      horarioFechamento: refeitorio.horario_fechamento,
      observacoes: refeitorio.observacoes
    }
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const { nome, local, capacidade, tipo, horarioAbertura, horarioFechamento, observacoes } = req.body;

  if (!nome) {
    return res.status(400).json({
      success: false,
      message: 'Nome é obrigatório'
    });
  }

  // Check for duplicate name
  const existing = await db.get('SELECT id FROM refeitorios WHERE LOWER(nome) = LOWER(?)', [nome]);
  if (existing) {
    return res.status(400).json({
      success: false,
      message: 'Já existe um refeitório com este nome'
    });
  }

  const result = await db.run(
    `INSERT INTO refeitorios (nome, local, capacidade, tipo, horario_abertura, horario_fechamento, observacoes, created_by) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nome,
      local || null,
      capacidade || null,
      tipo || 'interno',
      horarioAbertura || '07:00',
      horarioFechamento || '19:00',
      observacoes || null,
      req.user?.id || null
    ]
  );

  const refeitorio = await db.get('SELECT * FROM refeitorios WHERE id = ?', [result.lastID]);

  res.status(201).json({
    success: true,
    data: {
      id: refeitorio.id,
      nome: refeitorio.nome,
      local: refeitorio.local,
      capacidade: refeitorio.capacidade,
      tipo: refeitorio.tipo,
      horarioAbertura: refeitorio.horario_abertura,
      horarioFechamento: refeitorio.horario_fechamento,
      observacoes: refeitorio.observacoes
    },
    message: 'Refeitório criado com sucesso'
  });

  // Log audit
  await auditService.logCreate(req, 'refeitorio', refeitorio.id, `Criação de refeitório: ${refeitorio.nome}`, refeitorio);
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { nome, local, capacidade, tipo, horarioAbertura, horarioFechamento, observacoes } = req.body;

  const existing = await db.get('SELECT id FROM refeitorios WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({
      success: false,
      message: 'Refeitório não encontrado'
    });
  }

  if (nome) {
    const duplicate = await db.get('SELECT id FROM refeitorios WHERE LOWER(nome) = LOWER(?) AND id != ?', [nome, id]);
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: 'Já existe outro refeitório com este nome'
      });
    }
  }

  await db.run(
    `UPDATE refeitorios 
     SET nome = ?, local = ?, capacidade = ?, tipo = ?, 
         horario_abertura = ?, horario_fechamento = ?, observacoes = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nome || existing.nome,
      local !== undefined ? local : existing.local,
      capacidade !== undefined ? capacidade : existing.capacidade,
      tipo || existing.tipo,
      horarioAbertura || existing.horario_abertura,
      horarioFechamento || existing.horario_fechamento,
      observacoes !== undefined ? observacoes : existing.observacoes,
      id
    ]
  );

  const refeitorio = await db.get('SELECT * FROM refeitorios WHERE id = ?', [id]);

  res.json({
    success: true,
    data: {
      id: refeitorio.id,
      nome: refeitorio.nome,
      local: refeitorio.local,
      capacidade: refeitorio.capacidade,
      tipo: refeitorio.tipo,
      horarioAbertura: refeitorio.horario_abertura,
      horarioFechamento: refeitorio.horario_fechamento,
      observacoes: refeitorio.observacoes
    },
    message: 'Refeitório atualizado com sucesso'
  });

  // Log audit
  await auditService.logUpdate(req, 'refeitorio', id, `Atualização de refeitório: ${refeitorio.nome}`, existing, refeitorio);
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const existing = await db.get('SELECT id FROM refeitorios WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({
      success: false,
      message: 'Refeitório não encontrado'
    });
  }

  await db.run('DELETE FROM refeitorios WHERE id = ?', [id]);

  res.json({
    success: true,
    message: 'Refeitório excluído com sucesso'
  });

  // Log audit
  await auditService.logDelete(req, 'refeitorio', id, `Exclusão de refeitório: ${existing.nome || id}`, existing);
});

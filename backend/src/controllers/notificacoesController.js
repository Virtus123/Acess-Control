import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../config/logger.js';

/**
 * Controller para Gerenciamento de Notificações por Email
 */

// Listar notificações (Todas, para gerenciamento)
export const listar = asyncHandler(async (req, res) => {
  const db = req.db;
  
  const notificacoes = await db.all(
    'SELECT * FROM notificacoes ORDER BY created_at DESC'
  );

  // Parse do JSON de grupos
  const data = notificacoes.map(n => ({
    ...n,
    grupos: JSON.parse(n.grupos || '[]')
  }));

  res.json({ success: true, data });
});

// Criar nova notificação
export const criar = asyncHandler(async (req, res) => {
  const db = req.db;
  const { nome, tipo_evento, grupos, assunto, corpo } = req.body;

  if (!nome || !tipo_evento || !assunto || !corpo) {
    return res.status(400).json({ 
      success: false, 
      message: 'Campos obrigatórios: nome, tipo_evento, assunto, corpo' 
    });
  }

  const result = await db.run(
    `INSERT INTO notificacoes (nome, tipo_evento, grupos, assunto, corpo) 
     VALUES (?, ?, ?, ?, ?)`,
    [nome, tipo_evento, JSON.stringify(grupos || []), assunto, corpo]
  );

  res.status(201).json({ 
    success: true, 
    data: { id: result.lastID },
    message: 'Notificação criada com sucesso'
  });
});

// Buscar notificação por ID
export const buscarNotificacao = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const regra = await db.get('SELECT * FROM notificacoes WHERE id = ?', [id]);
  
  if (!regra) {
    return res.status(404).json({ success: false, message: 'Não encontrado' });
  }

  regra.grupos = JSON.parse(regra.grupos || '[]');

  res.json({ success: true, data: regra });
});

// Editar notificação
export const editar = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { nome, tipo_evento, grupos, assunto, corpo, ativo } = req.body;

  const existing = await db.get('SELECT id FROM notificacoes WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Notificação não encontrada' });
  }

  await db.run(
    `UPDATE notificacoes SET 
      nome = COALESCE(?, nome),
      tipo_evento = COALESCE(?, tipo_evento),
      grupos = COALESCE(?, grupos),
      assunto = COALESCE(?, assunto),
      corpo = COALESCE(?, corpo),
      ativo = COALESCE(?, ativo),
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nome, tipo_evento, grupos ? JSON.stringify(grupos) : null, assunto, corpo, ativo, id]
  );

  res.json({ success: true, message: 'Notificação atualizada com sucesso' });
});

// Toggle status ativo/inativo
export const toggleNotificacao = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const regra = await db.get('SELECT ativo FROM notificacoes WHERE id = ?', [id]);
  
  if (!regra) {
    return res.status(404).json({ success: false, message: 'Não encontrado' });
  }

  const novoAtivo = regra.ativo === 1 ? 0 : 1;

  await db.run(
    'UPDATE notificacoes SET ativo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [novoAtivo, id]
  );

  res.json({ success: true, data: { id, ativo: novoAtivo } });
});

// Excluir notificação (Real Delete)
export const excluir = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const existing = await db.get('SELECT id FROM notificacoes WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Não encontrado' });
  }

  await db.run('DELETE FROM notificacoes WHERE id = ?', [id]);

  res.json({ success: true, message: 'Regra excluída com sucesso' });
});

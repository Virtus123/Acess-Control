import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';
import emailService from '../services/emailService.js';
import pushService from '../services/pushService.js';
import fs from 'fs';
import { join } from 'path';

// Listar todas as encomendas com filtros
export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 50, search, status, dataInicio, dataFim } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM encomendas WHERE 1=1';
  const params = [];

  // Filtro por status
  if (status && status !== 'todos') {
    query += ' AND status = ?';
    params.push(status);
  }

  // Filtro por busca (código, destinatário, remetente)
  if (search) {
    query += ' AND (codigo LIKE ? OR destinatario_nome LIKE ? OR remetente_nome LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  // Filtro por data de chegada
  if (dataInicio) {
    query += ' AND date(data_chegada) >= date(?)';
    params.push(dataInicio);
  }
  if (dataFim) {
    query += ' AND date(data_chegada) <= date(?)';
    params.push(dataFim);
  }

  query += ' ORDER BY data_chegada DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const encomendas = await db.all(query, params);

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: encomendas.map(formatEncomenda),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Buscar encomenda por ID
export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const encomenda = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);

  if (!encomenda) {
    return res.status(404).json({
      success: false,
      message: 'Encomenda não encontrada'
    });
  }

  res.json({
    success: true,
    data: formatEncomenda(encomenda)
  });
});

// Criar nova encomenda
export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const {
    codigo, tipo, categoria, urgente, peso, dimensoes, descricao, observacoes,
    destinatario, documento, telefone, email, unidade, bloco,
    remetente, remetenteDocumento, remetenteTelefone, origem,
    dataChegada, status,
    grupoId, companyId, pessoaId
  } = req.body;

  let finalCodigo = codigo;
  if (!finalCodigo) {
    finalCodigo = `ENC${Date.now().toString().slice(-8)}`;
  }

  if (!destinatario && !pessoaId && !companyId) {
    return res.status(400).json({
      success: false,
      message: 'Selecione um destinatário, empresa ou pessoa'
    });
  }

  if (codigo) {
    const existing = await db.get('SELECT id FROM encomendas WHERE codigo = ?', [codigo]);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Já existe uma encomenda com este código'
      });
    }
  }

  const query = `INSERT INTO encomendas (
    codigo, tipo, categoria, urgente, peso, dimensoes, descricao, observacoes,
    destinatario_nome, destinatario_documento, destinatario_telefone, destinatario_email,
    destinatario_unidade, destinatario_bloco,
    destinatario_grupo_id, destinatario_company_id, destinatario_pessoa_id,
    remetente_nome, remetente_documento, remetente_telefone, remetente_origem,
    data_chegada, status, created_by
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const values = [
    finalCodigo,
    tipo || 'pacote',
    categoria || null,
    urgente ? 1 : 0,
    peso || null,
    dimensoes || null,
    descricao || null,
    observacoes || null,
    destinatario || 'Encomenda',
    documento || null,
    telefone || null,
    email || null,
    unidade || null,
    bloco || null,
    grupoId || null,
    companyId || null,
    pessoaId || null,
    remetente || null,
    remetenteDocumento || null,
    remetenteTelefone || null,
    origem || null,
    dataChegada || new Date().toISOString(),
    status || 'pendente',
    req.user?.id || null
  ];

  const result = await db.run(query, values);
  const encomenda = await db.get('SELECT * FROM encomendas WHERE id = ?', [result.lastID]);

  res.status(201).json({ 
    success: true, 
    data: formatEncomenda(encomenda),
    message: 'Encomenda criada com sucesso'
  });

  // DISPARAR NOTIFICAÇÃO ESPECIALIZADA
  emailService.dispararEmailEncomenda({
    tenantId: req.tenantId,
    encomenda: {
      id:           result.lastID || null,
      companyId:    companyId  || null,
      pessoaId:     pessoaId   || null,
      destinatario: destinatario || '',
      descricao:    descricao  || tipo || '',
      tipo:         tipo       || '',
      dataChegada:  dataChegada || new Date().toISOString(),
      operadorId:   req.user?.id    || null,
      nomeOperador: req.user?.name  || ''
    }
  }).catch(err => 
    console.error('[NotifEncomenda] Erro ao disparar email: ' + err.message)
  );

  // Push notification para dispositivos móveis do destinatário
  pushService.notifyNewEncomenda(db, req.tenantId, {
    id: result.lastID,
    pessoaId: pessoaId || null,
    companyId: companyId || null,
    destinatario: destinatario || '',
    tipo: tipo || 'pacote',
  }).catch(err => console.error('[PUSH] Erro:', err.message));

  await auditService.logCreate(req, 'encomenda', encomenda.id, `Criação de encomenda: ${encomenda.codigo}`, encomenda);
});

// Atualizar encomenda
export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const {
    codigo, tipo, categoria, urgente, peso, dimensoes, descricao, observacoes,
    destinatario, documento, telefone, email, unidade, bloco,
    remetente, remetenteDocumento, remetenteTelefone, origem,
    dataChegada, dataRetirada, status, responsavel,
    grupoId, companyId, pessoaId
  } = req.body;

  const existing = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Encomenda não encontrada' });
  }

  const query = `UPDATE encomendas SET
    codigo = ?, tipo = ?, categoria = ?, urgente = ?, peso = ?, dimensoes = ?,
    descricao = ?, observacoes = ?,
    destinatario_nome = ?, destinatario_documento = ?, destinatario_telefone = ?,
    destinatario_email = ?, destinatario_unidade = ?, destinatario_bloco = ?,
    destinatario_grupo_id = ?, destinatario_company_id = ?, destinatario_pessoa_id = ?,
    remetente_nome = ?, remetente_documento = ?, remetente_telefone = ?,
    remetente_origem = ?, data_chegada = ?, data_retirada = ?, status = ?,
    responsavel_retirada = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?`;

  const params = [
    codigo || existing.codigo,
    tipo || existing.tipo,
    categoria || existing.categoria,
    urgente !== undefined ? (urgente ? 1 : 0) : existing.urgente,
    peso !== undefined ? peso : existing.peso,
    dimensoes !== undefined ? dimensoes : existing.dimensoes,
    descricao !== undefined ? descricao : existing.descricao,
    observacoes !== undefined ? observacoes : existing.observacoes,
    destinatario || existing.destinatario_nome,
    documento !== undefined ? documento : existing.destinatario_documento,
    telefone !== undefined ? telefone : existing.destinatario_telefone,
    email !== undefined ? email : existing.destinatario_email,
    unidade !== undefined ? unidade : existing.destinatario_unidade,
    bloco !== undefined ? bloco : existing.destinatario_bloco,
    grupoId !== undefined ? grupoId : existing.destinatario_grupo_id,
    companyId !== undefined ? companyId : existing.destinatario_company_id,
    pessoaId !== undefined ? pessoaId : existing.destinatario_pessoa_id,
    remetente !== undefined ? remetente : existing.remetente_nome,
    remetenteDocumento !== undefined ? remetenteDocumento : existing.remetente_documento,
    remetenteTelefone !== undefined ? remetenteTelefone : existing.remetente_telefone,
    origem !== undefined ? origem : existing.remetente_origem,
    dataChegada || existing.data_chegada,
    dataRetirada !== undefined ? dataRetirada : existing.data_retirada,
    status || existing.status,
    responsavel !== undefined ? responsavel : existing.responsavel_retirada,
    id
  ];

  await db.run(query, params);
  const encomenda = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);

  res.json({
    success: true,
    data: formatEncomenda(encomenda),
    message: 'Encomenda atualizada com sucesso'
  });

  await auditService.logUpdate(req, 'encomenda', id, `Atualização de encomenda: ${encomenda.codigo}`, existing, encomenda);
});

// Excluir encomenda
export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const existing = await db.get('SELECT id, codigo FROM encomendas WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Encomenda não encontrada' });
  }

  await db.run('DELETE FROM encomendas WHERE id = ?', [id]);

  res.json({ success: true, message: 'Encomenda excluída com sucesso' });
  await auditService.logDelete(req, 'encomenda', id, `Exclusão de encomenda: ${existing.codigo}`, existing);
});

// Registrar retirada
export const registrarRetirada = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { responsavel } = req.body;

  const existing = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Encomenda não encontrada' });
  }

  await db.run(
    `UPDATE encomendas SET
      status = 'entregue',
      data_retirada = CURRENT_TIMESTAMP,
      responsavel_retirada = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [responsavel || 'Retirada presencial', id]
  );

  const encomenda = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);
  res.json({ success: true, data: formatEncomenda(encomenda), message: 'Retirada registrada com sucesso' });

  await auditService.logAction({ req, action: 'UPDATE', entity_type: 'encomenda', entity_id: id, description: `Entrega/Retirada de encomenda: ${encomenda.codigo} (Responsável: ${responsavel})`, old_values: existing, new_values: encomenda });
});

// Listar encomendas pendentes para o app
export const listPending = asyncHandler(async (req, res) => {
  const db = req.db;
  const { search, companyId } = req.query;

  console.log('[DEBUG] Backend listPending - Incoming Query:', { search, companyId, tenant: req.tenantId });

  let query = "SELECT * FROM encomendas WHERE status IN ('pendente', 'aguarda_retirada')";
  const params = [];

  if (search) {
    query += ' AND (codigo LIKE ? OR destinatario_nome LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
  }

  if (companyId && companyId !== 'null' && companyId !== 'undefined') {
    query += ' AND destinatario_company_id = ?';
    params.push(companyId);
  }

  query += ' ORDER BY data_chegada DESC';
  
  console.log('[DEBUG] Backend listPending - SQL Query:', query);
  console.log('[DEBUG] Backend listPending - Params:', params);

  const encomendas = await db.all(query, params);
  
  console.log('[DEBUG] Backend listPending - Found RESULTS:', encomendas.length);
  
  res.json({ success: true, data: encomendas.map(formatEncomenda) });
});

// Registrar entrega via app (com assinatura)
export const deliverViaApp = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { assinatura, nomeRecebedor } = req.body;
  const tenantId = req.tenantId || 'default';

  const ip = req.ip || req.connection?.remoteAddress || 'Unknown';
  const device = req.headers['user-agent'] || 'Mobile App';

  const existing = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'Encomenda não encontrada' });
  }

  let signaturePath = assinatura || null;

  if (assinatura && assinatura.startsWith('data:image')) {
    try {
      const base64Data = assinatura.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `${tenantId}_${existing.codigo || id}_${Date.now()}.png`;
      const relPath = `signature/${filename}`;
      const fullPath = join(process.cwd(), 'public', 'uploads', relPath);

      const dir = join(process.cwd(), 'public', 'uploads', 'signature');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      fs.writeFileSync(fullPath, buffer);
      signaturePath = `/uploads/${relPath}`;
    } catch (err) {
      console.error('[DELIVERY] Erro ao salvar assinatura:', err);
    }
  }

  await db.run(
    `UPDATE encomendas SET
      status = 'entregue',
      data_entrega_app = CURRENT_TIMESTAMP,
      data_retirada = CURRENT_TIMESTAMP,
      assinatura_app = ?,
      ip_recebimento = ?,
      device_recebimento = ?,
      responsavel_retirada = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`,
    [signaturePath, ip, device, nomeRecebedor || 'App', id]
  );

  const encomenda = await db.get('SELECT * FROM encomendas WHERE id = ?', [id]);
  res.json({ success: true, data: formatEncomenda(encomenda), message: 'Entrega registrada via app' });
});

// Estatísticas para dashboard
export const stats = asyncHandler(async (req, res) => {
  const db = req.db;
  const total = await db.get('SELECT COUNT(*) as count FROM encomendas');
  const pendentes = await db.get("SELECT COUNT(*) as count FROM encomendas WHERE status = 'pendente'");
  const entregues = await db.get("SELECT COUNT(*) as count FROM encomendas WHERE status = 'entregue'");
  const urgentes = await db.get('SELECT COUNT(*) as count FROM encomendas WHERE urgente = 1 AND status = "pendente"');

  res.json({
    success: true,
    data: {
      total: total.count,
      pendentes: pendentes.count,
      entregues: entregues.count,
      urgentes: urgentes.count
    }
  });
});

// Função auxiliar para formatar dados
function formatEncomenda(enc) {
  return {
    id: enc.id,
    codigo: enc.codigo,
    tipo: enc.tipo,
    categoria: enc.categoria,
    urgente: enc.urgente === 1,
    peso: enc.peso,
    dimensoes: enc.dimensoes,
    descricao: enc.descricao,
    observacoes: enc.observacoes,
    destinatario: enc.destinatario_nome,
    documento: enc.destinatario_documento,
    telefone: enc.destinatario_telefone,
    email: enc.destinatario_email,
    unidade: enc.destinatario_unidade,
    bloco: enc.destinatario_bloco,
    grupoId: enc.destinatario_grupo_id,
    companyId: enc.destinatario_company_id,
    pessoaId: enc.destinatario_pessoa_id,
    remetente: enc.remetente_nome,
    remetenteDocumento: enc.remetente_documento,
    remetenteTelefone: enc.remetente_telefone,
    origem: enc.remetente_origem,
    dataChegada: enc.data_chegada,
    dataRetirada: enc.data_retirada,
    dataEntregaApp: enc.data_entrega_app,
    status: enc.status,
    assinaturaApp: enc.assinatura_app,
    responsavel: enc.responsavel_retirada
  };
}

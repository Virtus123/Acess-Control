import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ReportJobService {
  constructor() {
    this.reportsDir = join(process.cwd(), 'public', 'reports');
  }

  async init() {
    await fs.mkdir(this.reportsDir, { recursive: true });
  }

  async createJob(tenantId, options) {
    await this.init();
    const db = await dbManager.getConnection(tenantId);

    // Garantir tabela existe
    await db.run(`
      CREATE TABLE IF NOT EXISTS report_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        report_type TEXT NOT NULL,
        orientation TEXT NOT NULL DEFAULT 'portrait',
        status TEXT NOT NULL DEFAULT 'pending',
        filters TEXT,
        file_path TEXT,
        filename TEXT,
        total_records INTEGER,
        error_message TEXT,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        expires_at DATETIME
      )
    `);
    try { await db.run('ALTER TABLE report_jobs ADD COLUMN orientation TEXT NOT NULL DEFAULT \'portrait\''); } catch(e){}

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Garante coluna 'format' para jobs antigos
    try { await db.run('ALTER TABLE report_jobs ADD COLUMN format TEXT NOT NULL DEFAULT \'pdf\''); } catch(e){}

    // O formato fica também em filters.format pra preservar compat com clients
    // antigos, mas guardamos numa coluna própria pra facilitar listagem/filtros.
    const filtersWithFormat = { ...(options.filters || {}) };
    if (options.format) filtersWithFormat.format = options.format;

    const result = await db.run(
      `INSERT INTO report_jobs (tenant_id, report_type, orientation, format, status, filters, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        tenantId,
        options.report_type,
        options.orientation || 'portrait',
        options.format || 'pdf',
        JSON.stringify(filtersWithFormat),
        options.created_by,
        new Date().toISOString(),
        expiresAt
      ]
    );

    return await db.get('SELECT * FROM report_jobs WHERE id = ?', [result.lastID]);
  }

  async processJob(tenantId, jobId) {
    const db = await dbManager.getConnection(tenantId);

    try {
      await db.run('UPDATE report_jobs SET status = ? WHERE id = ?', ['processing', jobId]);

      const job = await db.get('SELECT * FROM report_jobs WHERE id = ?', [jobId]);
      if (!job) throw new Error('Job não encontrado');

      const filters = JSON.parse(job.filters || '{}');
      let dados = [];
      let titulo = '';
      let colunas = [];

      switch (job.report_type) {
        case 'access':
          ({ dados, titulo, colunas } = await this._fetchAccessData(db, tenantId, filters));
          break;
        case 'access_por_empresa':
          ({ dados, titulo, colunas } = await this._fetchAccessPorEmpresa(db, tenantId, filters));
          break;
        case 'vehicles':
          ({ dados, titulo, colunas } = await this._fetchVehicleData(db, tenantId, filters));
          break;
        case 'vehicles_por_empresa':
          ({ dados, titulo, colunas } = await this._fetchVehiclesPorEmpresa(db, tenantId, filters));
          break;
        case 'persons':
          ({ dados, titulo, colunas } = await this._fetchPersonsData(db, tenantId, filters));
          break;
        case 'visitors':
          ({ dados, titulo, colunas } = await this._fetchVisitorsData(db, tenantId, filters));
          break;
        case 'companies':
          ({ dados, titulo, colunas } = await this._fetchCompaniesData(db, tenantId, filters));
          break;
        case 'encomendas':
          ({ dados, titulo, colunas } = await this._fetchEncomendasData(db, tenantId, filters));
          break;
        default:
          throw new Error(`Tipo de relatório inválido: ${job.report_type}`);
      }

      const format = (job.format || 'pdf').toLowerCase();
      const ext = format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'csv' : 'pdf';
      const filename = `relatorio_${job.report_type}_${Date.now()}.${ext}`;
      const filePath = join(this.reportsDir, filename);

      if (format === 'xlsx') {
        await this._generateXLSX({ filePath, titulo, dados, colunas });
      } else if (format === 'csv') {
        await this._generateCSV({ filePath, dados, colunas });
      } else {
        await this._generatePDF({
          filePath, titulo, dados, colunas, filters,
          orientation: job.orientation || 'portrait',
          tenantId
        });
      }

      await db.run(
        `UPDATE report_jobs SET status = 'completed', file_path = ?, filename = ?, total_records = ?, completed_at = ? WHERE id = ?`,
        [filePath, filename, dados.length, new Date().toISOString(), jobId]
      );

      logger.info(`[ReportJob] Concluído: ${filename}`, { tenantId, jobId });
    } catch (error) {
      logger.error('[ReportJob] Erro:', { tenantId, jobId, error: error.message });
      await db.run(
        `UPDATE report_jobs SET status = 'failed', error_message = ? WHERE id = ?`,
        [error.message, jobId]
      );
      throw error;
    }
  }

  // ─── Fetchers de dados ────────────────────────────────────────────────────

  async _fetchAccessData(db, tenantId, filters) {
    let query = `
      SELECT
        al.created_at as dataHora,
        al.action as direcao,
        al.status as autorizacao,
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
        e.name as equipamento,
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
    if (filters.startDate) { query += ' AND al.created_at >= ?'; params.push(filters.startDate); }
    if (filters.endDate)   { query += ' AND al.created_at <= ?'; params.push(filters.endDate); }
    if (filters.direction) { query += ' AND al.action = ?'; params.push(filters.direction.toUpperCase()); }
    if (filters.status)    { query += ' AND al.status = ?'; params.push(filters.status.toUpperCase()); }
    if (filters.groupId)   { query += ' AND p.group_id = ?'; params.push(parseInt(filters.groupId)); }
    if (filters.companyId) { query += ' AND (p.company_id = ? OR v.visited_company_id = ?)'; params.push(parseInt(filters.companyId), parseInt(filters.companyId)); }
    if (filters.personType) { query += ' AND al.person_type = ?'; params.push(filters.personType); }
    query += ' ORDER BY al.created_at DESC LIMIT 100000';

    const rows = await db.all(query, params);
    const colunasSelecionadas = filters.columns ? JSON.parse(filters.columns) : ['nome', 'dataHora', 'direcao', 'equipamento', 'empresa', 'grupo', 'autorizacao', 'matricula'];
    const labelsMap = { nome: 'Nome', dataHora: 'Data/Hora', direcao: 'Direção', equipamento: 'Equipamento', empresa: 'Empresa', grupo: 'Grupo', autorizacao: 'Autorização', matricula: 'Matrícula', documento: 'Documento' };

    const dados = rows.map(r => {
      const row = {};
      colunasSelecionadas.forEach(col => {
        let val = r[col] || '-';
        if (col === 'dataHora' && val !== '-') {
          try { val = new Date(val).toLocaleString('pt-BR'); } catch(e){}
        }
        if (col === 'direcao') val = val === 'entry' || val === 'ENTRY' ? '→ ENTRADA' : val === 'exit' || val === 'EXIT' ? '← SAÍDA' : val;
        if (col === 'autorizacao') {
          if (['success','SUCCESS','authorized','AUTHORIZED'].includes(val)) val = 'LIBERADO';
          else if (['denied','DENIED'].includes(val)) val = 'NEGADO';
        }
        row[col] = val;
      });
      return row;
    });

    return { dados, titulo: 'RELATÓRIO DE ACESSOS', colunas: colunasSelecionadas.map(c => ({ key: c, label: labelsMap[c] || c })) };
  }

  async _fetchAccessPorEmpresa(db, tenantId, filters) {
    const { dados: acessos } = await this._fetchAccessData(db, tenantId, { ...filters, columns: JSON.stringify(['nome', 'dataHora', 'direcao', 'autorizacao', 'empresa']) });
    const porEmpresa = {};
    const sorted = [...acessos].sort((a, b) => new Date(a.dataHora) - new Date(b.dataHora));
    sorted.forEach(item => {
      const emp = item.empresa || 'Sem empresa';
      if (!porEmpresa[emp]) porEmpresa[emp] = { empresa: emp, pessoas: new Set() };
      if (item.direcao && item.direcao.includes('ENTRADA')) porEmpresa[emp].pessoas.add(item.nome);
      else if (item.direcao && item.direcao.includes('SAÍDA')) porEmpresa[emp].pessoas.delete(item.nome);
    });
    const dados = Object.values(porEmpresa).map(e => ({ empresa: e.empresa, pessoasPresentes: e.pessoas.size }));
    return { dados, titulo: 'QUANTIDADE DE PRESENTES POR EMPRESA', colunas: [{ key: 'empresa', label: 'Empresa' }, { key: 'pessoasPresentes', label: 'Pessoas Presentes' }] };
  }

  async _fetchVehicleData(db, tenantId, filters) {
    let query = `
      SELECT
        al.created_at as dataHora,
        al.action as direcao,
        al.status as autorizacao,
        COALESCE(al.plate, v2.plate, '-') as placa,
        COALESCE(v2.model, '-') as modelo,
        COALESCE(v2.brand, '-') as marca,
        COALESCE(v2.color, '-') as cor,
        p.name as proprietario,
        COALESCE(cv.trading_name, cv.corporate_name, cp.trading_name, cp.corporate_name, '-') as empresa,
        COALESCE(v2.company_id, p.company_id) as empresaId,
        pk.name as estacionamento,
        e.name as equipamento
      FROM access_log al
      LEFT JOIN vehicles v2 ON al.vehicle_id = v2.id
      LEFT JOIN persons p ON COALESCE(v2.person_id, al.person_id) = p.id
      LEFT JOIN companies cv ON v2.company_id = cv.id
      LEFT JOIN companies cp ON p.company_id = cp.id
      LEFT JOIN parkings pk ON v2.parking_id = pk.id
      LEFT JOIN equipments e ON al.equipment_id = e.id
      WHERE al.tenant_id = ? AND al.access_type = 'VEHICLE'
    `;
    const params = [tenantId];
    if (filters.startDate) { query += ' AND al.created_at >= ?'; params.push(filters.startDate); }
    if (filters.endDate)   { query += ' AND al.created_at <= ?'; params.push(filters.endDate); }
    if (filters.direction) { query += ' AND al.action = ?'; params.push(filters.direction.toUpperCase()); }
    query += ' ORDER BY al.created_at DESC LIMIT 100000';

    const rows = await db.all(query, params);
    const colunasSelecionadas = filters.columns ? JSON.parse(filters.columns) : ['placa', 'modelo', 'marca', 'cor', 'proprietario', 'empresa', 'dataHora', 'direcao', 'autorizacao', 'equipamento'];
    const labelsMap = { placa: 'Placa', modelo: 'Modelo', marca: 'Marca', cor: 'Cor', proprietario: 'Proprietário', empresa: 'Empresa', dataHora: 'Data/Hora', direcao: 'Direção', autorizacao: 'Autorização', equipamento: 'Equipamento', estacionamento: 'Estacionamento' };

    const dados = rows.map(r => {
      const row = {};
      colunasSelecionadas.forEach(col => {
        let val = r[col] || '-';
        if (col === 'dataHora' && val !== '-') try { val = new Date(val).toLocaleString('pt-BR'); } catch(e){}
        if (col === 'direcao') val = val === 'entry' || val === 'ENTRY' ? '→ ENTRADA' : val === 'exit' || val === 'EXIT' ? '← SAÍDA' : val;
        if (col === 'autorizacao') {
          if (['success','SUCCESS'].includes(val)) val = 'LIBERADO';
          else if (['denied','DENIED'].includes(val)) val = 'NEGADO';
        }
        row[col] = val;
      });
      return row;
    });

    return { dados, titulo: 'RELATÓRIO DE ACESSOS DE VEÍCULOS', colunas: colunasSelecionadas.map(c => ({ key: c, label: labelsMap[c] || c })) };
  }

  async _fetchVehiclesPorEmpresa(db, tenantId, filters) {
    // Buscar acessos com empresaId para correlacionar com vagas
    let rawQuery = `
      SELECT al.created_at as dataHora, al.action as direcao,
        COALESCE(al.plate, v2.plate, '-') as placa,
        COALESCE(cv.trading_name, cv.corporate_name, cp.trading_name, cp.corporate_name, 'Sem empresa') as empresa,
        COALESCE(v2.company_id, p.company_id) as empresaId
      FROM access_log al
      LEFT JOIN vehicles v2 ON al.vehicle_id = v2.id
      LEFT JOIN persons p ON COALESCE(v2.person_id, al.person_id) = p.id
      LEFT JOIN companies cv ON v2.company_id = cv.id
      LEFT JOIN companies cp ON p.company_id = cp.id
      WHERE al.tenant_id = ? AND al.access_type = 'VEHICLE' AND al.status != 'DENIED'
    `;
    const params = [tenantId];
    if (filters.startDate) { rawQuery += ' AND al.created_at >= ?'; params.push(filters.startDate); }
    if (filters.endDate)   { rawQuery += ' AND al.created_at <= ?'; params.push(filters.endDate); }
    rawQuery += ' ORDER BY al.created_at ASC';

    const rows = await db.all(rawQuery, params);

    const porEmpresa = {};
    rows.forEach(item => {
      const emp = (!item.empresa || item.empresa === '-') ? 'Sem empresa' : item.empresa;
      if (!porEmpresa[emp]) porEmpresa[emp] = { empresa: emp, empresaId: item.empresaId || null, veiculos: new Set() };
      if (!porEmpresa[emp].empresaId && item.empresaId) porEmpresa[emp].empresaId = item.empresaId;
      const direcao = (item.direcao || '').toUpperCase();
      if (direcao === 'ENTRY') porEmpresa[emp].veiculos.add(item.placa);
      else if (direcao === 'EXIT') porEmpresa[emp].veiculos.delete(item.placa);
    });

    // Buscar vagas por empresa dos estacionamentos
    const vagasPorEmpresaId = {};
    try {
      const parkings = await db.all("SELECT total_spots, empresas FROM parkings WHERE active = 1");
      parkings.forEach(p => {
        if (!p.empresas) return;
        let cfg;
        try { cfg = typeof p.empresas === 'string' ? JSON.parse(p.empresas) : p.empresas; } catch(e) { return; }
        if (!Array.isArray(cfg)) return;
        cfg.forEach(e => {
          const vagas = parseInt(e.vagas) || 0;
          vagasPorEmpresaId[e.empresaId] = (vagasPorEmpresaId[e.empresaId] || 0) + vagas;
        });
      });
    } catch(e) {}

    const dados = Object.values(porEmpresa).map(e => {
      const vagasTotais = e.empresaId ? (vagasPorEmpresaId[e.empresaId] || 0) : 0;
      const veiculosPresentes = e.veiculos.size;
      return {
        empresa: e.empresa,
        veiculosPresentes,
        vagasTotais: vagasTotais > 0 ? vagasTotais : '-',
        vagasDisponiveis: vagasTotais > 0 ? Math.max(0, vagasTotais - veiculosPresentes) : '-'
      };
    });

    return {
      dados,
      titulo: 'QUANTIDADE DE VEÍCULOS PRESENTES POR EMPRESA',
      colunas: [
        { key: 'empresa', label: 'Empresa' },
        { key: 'veiculosPresentes', label: 'Veículos Presentes' },
        { key: 'vagasTotais', label: 'Vagas Totais' },
        { key: 'vagasDisponiveis', label: 'Vagas Disponíveis' }
      ]
    };
  }

  async _fetchPersonsData(db, tenantId, filters) {
    let query = `
      SELECT p.name as nome, p.registration_number as matricula, p.cpf, p.email, p.cellphone as telefone,
             p.profession as profissao, p.position as cargo, p.status, p.created_at as dataCadastro,
             g.name as grupo, COALESCE(c.trading_name, c.corporate_name, '-') as empresa
      FROM persons p
      LEFT JOIN groups g ON p.group_id = g.id
      LEFT JOIN companies c ON p.company_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (filters.status) { query += ' AND p.status = ?'; params.push(filters.status); }
    if (filters.groupId) { query += ' AND p.group_id = ?'; params.push(parseInt(filters.groupId)); }
    if (filters.companyId) { query += ' AND p.company_id = ?'; params.push(parseInt(filters.companyId)); }
    if (filters.search) {
      query += ' AND (p.name LIKE ? OR p.registration_number LIKE ? OR p.email LIKE ?)';
      const s = `%${filters.search}%`;
      params.push(s, s, s);
    }
    query += ' ORDER BY p.name ASC LIMIT 100000';
    const rows = await db.all(query, params);
    return {
      dados: rows,
      titulo: 'RELATÓRIO DE CADASTROS - PESSOAS',
      colunas: [
        { key: 'nome', label: 'Nome' }, { key: 'matricula', label: 'Matrícula' }, { key: 'cpf', label: 'CPF' },
        { key: 'email', label: 'E-mail' }, { key: 'telefone', label: 'Telefone' },
        { key: 'cargo', label: 'Cargo' }, { key: 'grupo', label: 'Grupo' },
        { key: 'empresa', label: 'Empresa' }, { key: 'status', label: 'Status' }
      ]
    };
  }

  async _fetchVisitorsData(db, tenantId, filters) {
    let query = `
      SELECT v.name as nome, v.document as cpf, v.cellphone as telefone, v.email,
             v.visitor_company as empresa, v.reason as motivo,
             v.entry_date as dataEntrada, v.exit_date as dataSaida, v.status,
             COALESCE(c.trading_name, c.corporate_name, '-') as empresaVisitada
      FROM visitors v
      LEFT JOIN companies c ON v.visited_company_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (filters.status) { query += ' AND v.status = ?'; params.push(filters.status); }
    if (filters.companyId) { query += ' AND v.visited_company_id = ?'; params.push(parseInt(filters.companyId)); }
    if (filters.startDate) { query += ' AND v.entry_date >= ?'; params.push(filters.startDate); }
    if (filters.endDate) { query += ' AND v.entry_date <= ?'; params.push(filters.endDate); }
    query += ' ORDER BY v.entry_date DESC LIMIT 100000';
    const rows = await db.all(query, params);
    return {
      dados: rows,
      titulo: 'RELATÓRIO DE CADASTROS - VISITANTES',
      colunas: [
        { key: 'nome', label: 'Nome' }, { key: 'cpf', label: 'Documento' },
        { key: 'telefone', label: 'Telefone' }, { key: 'empresa', label: 'Empresa do Visitante' },
        { key: 'empresaVisitada', label: 'Empresa Visitada' }, { key: 'motivo', label: 'Motivo' },
        { key: 'dataEntrada', label: 'Entrada' }, { key: 'dataSaida', label: 'Saída' }, { key: 'status', label: 'Status' }
      ]
    };
  }

  async _fetchCompaniesData(db, tenantId, filters) {
    let query = `SELECT c.id, c.corporate_name as nome, c.cnpj, c.phone as telefone, c.email, c.active FROM companies c WHERE 1=1`;
    const params = [];
    if (filters.active !== undefined) { query += ' AND c.active = ?'; params.push(filters.active === 'true' ? 1 : 0); }
    query += ' ORDER BY c.corporate_name ASC LIMIT 100000';
    const rows = await db.all(query, params);
    const dados = rows.map(r => ({ ...r, status: r.active === 1 ? 'ATIVO' : 'INATIVO' }));
    return {
      dados,
      titulo: 'RELATÓRIO DE CADASTROS - EMPRESAS',
      colunas: [
        { key: 'nome', label: 'Razão Social' }, { key: 'cnpj', label: 'CNPJ' },
        { key: 'telefone', label: 'Telefone' }, { key: 'email', label: 'E-mail' }, { key: 'status', label: 'Status' }
      ]
    };
  }

  async _fetchEncomendasData(db, tenantId, filters) {
    let query = `
      SELECT
        e.codigo,
        e.tipo,
        e.categoria,
        e.urgente,
        e.descricao,
        e.observacoes,
        e.destinatario_nome as destinatario,
        e.destinatario_unidade as unidade,
        e.destinatario_bloco as bloco,
        e.remetente_nome as remetente,
        e.remetente_origem as origem,
        e.data_chegada as dataChegada,
        e.data_retirada as dataRetirada,
        e.status,
        e.responsavel_retirada as responsavel,
        COALESCE(c.trading_name, c.corporate_name) as empresa
      FROM encomendas e
      LEFT JOIN companies c ON e.destinatario_company_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (filters.status) { query += ' AND e.status = ?'; params.push(filters.status); }
    if (filters.startDate) { query += ' AND e.data_chegada >= ?'; params.push(filters.startDate); }
    if (filters.endDate)   { query += ' AND e.data_chegada <= ?'; params.push(filters.endDate); }
    if (filters.search) {
      query += ' AND (e.codigo LIKE ? OR e.destinatario_nome LIKE ? OR e.remetente_nome LIKE ?)';
      const t = `%${filters.search}%`;
      params.push(t, t, t);
    }
    query += ' ORDER BY e.data_chegada DESC LIMIT 100000';
    const rows = await db.all(query, params);

    const statusLabel = { pendente: 'PENDENTE', recebida: 'RECEBIDA', retirada: 'RETIRADA', extraviada: 'EXTRAVIADA' };
    const dados = rows.map(r => ({
      ...r,
      urgente: r.urgente === 1 ? 'SIM' : 'NÃO',
      status: statusLabel[r.status] || (r.status || '-').toUpperCase(),
      dataChegada: r.dataChegada ? new Date(r.dataChegada).toLocaleString('pt-BR') : '-',
      dataRetirada: r.dataRetirada ? new Date(r.dataRetirada).toLocaleString('pt-BR') : '-',
    }));

    return {
      dados,
      titulo: 'RELATÓRIO DE ENCOMENDAS',
      colunas: [
        { key: 'codigo',       label: 'Código' },
        { key: 'tipo',         label: 'Tipo' },
        { key: 'destinatario', label: 'Destinatário' },
        { key: 'unidade',      label: 'Unidade' },
        { key: 'empresa',      label: 'Empresa' },
        { key: 'remetente',    label: 'Remetente' },
        { key: 'origem',       label: 'Origem' },
        { key: 'dataChegada',  label: 'Data Chegada' },
        { key: 'dataRetirada', label: 'Data Retirada' },
        { key: 'status',       label: 'Status' },
        { key: 'urgente',      label: 'Urgente' },
        { key: 'responsavel',  label: 'Responsável Retirada' },
      ]
    };
  }

  // ─── Geração do PDF ───────────────────────────────────────────────────────

  async _generatePDF({ filePath, titulo, dados, colunas, filters, orientation, tenantId }) {
    // Buscar dados da empresa para o cabeçalho
    let empresa = { razao: '', cnpj: '', endereco: '', telefone: '' };
    try {
      const db = await dbManager.getConnection(tenantId);
      const cfgs = await db.all("SELECT config_key, config_value FROM system_config WHERE config_key LIKE 'report_company_%'");
      cfgs.forEach(c => {
        const k = c.config_key.replace('report_company_', '');
        empresa[k] = c.config_value || '';
      });
    } catch(e) {}

    // Caminho da logo
    const logoPath = join(__dirname, '..', '..', '..', 'frontend', 'logo.png');

    return new Promise((resolve, reject) => {
      const ML = 35;  // margem esquerda
      const MT = 35;  // margem topo
      const MR = 35;  // margem direita
      const MB = 40;  // margem inferior

      const doc = new PDFDocument({
        size: 'A4',
        layout: orientation === 'landscape' ? 'landscape' : 'portrait',
        margins: { top: MT, bottom: MB, left: ML, right: MR },
        autoFirstPage: true,
        bufferPages: false,
      });

      const stream = createWriteStream(filePath);
      doc.pipe(stream);

      const PW = doc.page.width;
      const PH = doc.page.height;
      const contentW = PW - ML - MR;

      // ── Cabeçalho (função reutilizada em cada página nova) ──
      const desenharCabecalho = () => {
        // Logo
        try {
          if (existsSync(logoPath)) {
            doc.image(logoPath, PW - MR - 60, MT, { width: 55, height: 28, fit: [55, 28] });
          }
        } catch(e) {}

        // Dados da empresa
        let cy = MT;
        if (empresa.razao) {
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#1e293b').text(empresa.razao, ML, cy, { width: contentW - 70 });
          cy = doc.y + 1;
        }
        doc.fontSize(7.5).font('Helvetica').fillColor('#475569');
        if (empresa.cnpj)    { doc.text(`CNPJ: ${empresa.cnpj}`,       ML, cy, { width: contentW - 70 }); cy = doc.y; }
        if (empresa.endereco){ doc.text(empresa.endereco,               ML, cy, { width: contentW - 70 }); cy = doc.y; }
        if (empresa.telefone){ doc.text(`Tel: ${empresa.telefone}`,     ML, cy, { width: contentW - 70 }); cy = doc.y; }

        // Linha separadora
        const sepY = Math.max(cy + 4, MT + 34);
        doc.moveTo(ML, sepY).lineTo(PW - MR, sepY).strokeColor('#cbd5e1').lineWidth(0.5).stroke();

        // Título do relatório
        const titleY = sepY + 8;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e293b').text(titulo, ML, titleY);
        let infoY = doc.y + 3;

        // Período e data de geração
        doc.fontSize(7.5).font('Helvetica').fillColor('#64748b');
        const partes = [];
        if (filters.startDate) partes.push(`De: ${String(filters.startDate).split('T')[0]}`);
        if (filters.endDate)   partes.push(`Ate: ${String(filters.endDate).split('T')[0]}`);
        partes.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
        doc.text(partes.join('   |   '), ML, infoY, { width: contentW });
        infoY = doc.y + 6;

        doc.moveTo(ML, infoY).lineTo(PW - MR, infoY).strokeColor('#cbd5e1').lineWidth(0.5).stroke();

        return infoY + 8; // startY da tabela
      };

      let tableStartY = desenharCabecalho();
      this._drawTable(doc, colunas, dados, tableStartY, contentW, ML, PH, MB, desenharCabecalho);

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }

  _drawTable(doc, colunas, dados, startY, pageWidth, ML, PH, MB, onNewPage) {
    const FONT_SIZE = 7;
    const CELL_PAD_X = 4;
    const CELL_PAD_Y = 3;
    const HEADER_H = 18;
    const MIN_ROW_H = 14;
    const MAX_COL_W = 140; // largura máxima de uma coluna

    // Calcular larguras proporcionais das colunas
    // Dar mais espaço para colunas de texto longo
    const WIDE_KEYS = ['nome','destinatario','empresa','proprietario','remetente','message','observacoes','responsavel','equipamento'];
    const baseW = pageWidth / colunas.length;
    let colWidths;
    if (colunas.length <= 4) {
      colWidths = colunas.map(() => pageWidth / colunas.length);
    } else {
      // Distribuir proporcionalmente: colunas "largas" pegam 1.6x, demais 1x
      const wideCount = colunas.filter(c => WIDE_KEYS.includes(c.key)).length;
      const normalCount = colunas.length - wideCount;
      const unit = pageWidth / (normalCount + wideCount * 1.6);
      colWidths = colunas.map(c => WIDE_KEYS.includes(c.key) ? Math.min(unit * 1.6, MAX_COL_W) : unit);
      // Normalizar para preencher a largura total
      const total = colWidths.reduce((a, b) => a + b, 0);
      colWidths = colWidths.map(w => w * (pageWidth / total));
    }

    doc.fontSize(FONT_SIZE).font('Helvetica');

    // Pré-calcular altura de cada linha com base no conteúdo real
    const calcRowH = (row) => {
      let maxLines = 1;
      colunas.forEach((col, i) => {
        const val = String(row[col.key] ?? '-');
        const w = colWidths[i] - CELL_PAD_X * 2;
        // Estimativa de linhas necessárias (pdfkit ~6px por char na fonte 7)
        const charsPerLine = Math.floor(w / 4.2);
        const lines = charsPerLine > 0 ? Math.ceil(val.length / charsPerLine) : 1;
        maxLines = Math.max(maxLines, Math.min(lines, 3)); // máx 3 linhas por célula
      });
      return Math.max(MIN_ROW_H, maxLines * (FONT_SIZE + 2) + CELL_PAD_Y * 2);
    };

    // Função para desenhar o cabeçalho da tabela
    const desenharHeaderTabela = (y) => {
      doc.rect(ML, y, pageWidth, HEADER_H).fill('#4a90d9');
      doc.font('Helvetica-Bold').fontSize(FONT_SIZE - 0.5).fillColor('#ffffff');
      let xh = ML;
      colunas.forEach((col, i) => {
        doc.text(col.label.toUpperCase(), xh + CELL_PAD_X, y + 5, {
          width: colWidths[i] - CELL_PAD_X * 2,
          lineBreak: false,
          ellipsis: true,
        });
        xh += colWidths[i];
      });
      return y + HEADER_H;
    };

    let y = desenharHeaderTabela(startY);
    doc.font('Helvetica').fontSize(FONT_SIZE);

    dados.forEach((row, rowIdx) => {
      const rowH = calcRowH(row);

      // Quebra de página
      if (y + rowH > PH - MB - 15) {
        doc.addPage();
        doc.fontSize(FONT_SIZE).font('Helvetica');
        const newTableY = onNewPage ? onNewPage() : 40;
        y = desenharHeaderTabela(newTableY);
        doc.font('Helvetica').fontSize(FONT_SIZE);
      }

      // Fundo alternado
      const bg = rowIdx % 2 === 0 ? '#f8fafc' : '#ffffff';
      doc.rect(ML, y, pageWidth, rowH).fill(bg);

      // Borda inferior
      doc.moveTo(ML, y + rowH).lineTo(ML + pageWidth, y + rowH)
        .strokeColor('#e2e8f0').lineWidth(0.3).stroke();

      // Texto das células
      doc.fillColor('#1e293b');
      let xc = ML;
      colunas.forEach((col, i) => {
        const rawVal = String(row[col.key] ?? '-');
        const cellW = colWidths[i] - CELL_PAD_X * 2;
        const maxH = rowH - CELL_PAD_Y;
        const cellX = xc + CELL_PAD_X;
        const cellY = y + CELL_PAD_Y;

        // Direção: badge colorido (verde = entrada, vermelho = saída)
        if (col.key === 'direcao') {
          const v = rawVal.toLowerCase();
          const isEntrada = v.includes('entry') || v.includes('entrada');
          const isSaida   = v.includes('exit')  || v.includes('saida') || v.includes('saída');

          if (isEntrada || isSaida) {
            const badgeColor = isEntrada ? '#22c55e' : '#ef4444';
            const badgeLabel = isEntrada ? 'ENTRADA' : 'SAIDA';
            const badgeW = Math.min(cellW, 46);
            const badgeH = 11;
            const badgeY = cellY + (rowH - CELL_PAD_Y * 2 - badgeH) / 2;
            doc.save();
            doc.roundedRect(cellX, badgeY, badgeW, badgeH, 3).fill(badgeColor);
            doc.font('Helvetica-Bold').fontSize(FONT_SIZE - 1).fillColor('#ffffff');
            doc.text(badgeLabel, cellX, badgeY + 2, { width: badgeW, align: 'center', lineBreak: false });
            doc.restore();
            doc.font('Helvetica').fontSize(FONT_SIZE).fillColor('#1e293b');
          } else {
            doc.text(rawVal, cellX, cellY, { width: cellW, height: maxH, ellipsis: true, lineBreak: false });
          }
        } else {
          doc.text(rawVal, cellX, cellY, {
            width: cellW,
            height: maxH,
            ellipsis: true,
            lineBreak: true,
          });
        }
        xc += colWidths[i];
      });

      y += rowH;
    });

    // Rodapé — total de registros
    const footerNeeded = 18;
    if (y + footerNeeded > PH - MB) { doc.addPage(); y = onNewPage ? onNewPage() : 40; }
    doc.fontSize(8).font('Helvetica').fillColor('#475569')
      .text(`Total de registros: ${dados.length}`, ML, y + 6);
  }

  // ─── Gerador XLSX ─────────────────────────────────────────────────────────

  async _generateXLSX({ filePath, titulo, dados, colunas }) {
    // Monta linhas com header legível baseado nos labels das colunas
    const header = colunas.map(c => c.label || c.key);
    const aoa = [header];
    dados.forEach(row => {
      aoa.push(colunas.map(c => {
        const v = row[c.key];
        if (v === null || v === undefined) return '';
        return String(v);
      }));
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Auto-width simples (limite 60)
    ws['!cols'] = colunas.map((_, i) => ({
      wch: Math.min(60, Math.max(10, ...aoa.map(r => String(r[i] || '').length)))
    }));
    XLSX.utils.book_append_sheet(wb, ws, (titulo || 'Relatorio').slice(0, 30));
    XLSX.writeFile(wb, filePath);
  }

  // ─── Gerador CSV ──────────────────────────────────────────────────────────

  async _generateCSV({ filePath, dados, colunas }) {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Escapa aspas duplicando, e cerca em aspas se contiver ; , " ou newline
      if (/[;,"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const sep = ';'; // padrão Excel pt-BR
    const header = colunas.map(c => escape(c.label || c.key)).join(sep);
    const rows = dados.map(row =>
      colunas.map(c => escape(row[c.key])).join(sep)
    );
    // BOM UTF-8 para o Excel reconhecer acentos corretamente
    const content = '﻿' + header + '\n' + rows.join('\n');
    await fs.writeFile(filePath, content, 'utf8');
  }

  // ─── Limpeza de jobs expirados ────────────────────────────────────────────

  async cleanupExpiredJobs(tenantId) {
    try {
      const db = await dbManager.getConnection(tenantId);
      const expired = await db.all(
        `SELECT file_path FROM report_jobs WHERE expires_at < ? AND file_path IS NOT NULL`,
        [new Date().toISOString()]
      );
      for (const job of expired) {
        try { await fs.unlink(job.file_path); } catch(e) {}
      }
      await db.run(`DELETE FROM report_jobs WHERE expires_at < ?`, [new Date().toISOString()]);
    } catch(e) {
      logger.warn('[ReportJob] Erro na limpeza de jobs expirados:', e.message);
    }
  }
}

export default new ReportJobService();

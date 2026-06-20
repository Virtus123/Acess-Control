import XLSX from 'xlsx';
import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ExportService {
  constructor() {
    this.exportsDir = join(process.cwd(), 'public', 'exports');
  }

  async init() {
    await fs.mkdir(this.exportsDir, { recursive: true });
  }

  async createJob(tenantId, options) {
    await this.init();

    const db = await dbManager.getConnection(tenantId);
    const result = await db.run(
      `INSERT INTO export_jobs (tenant_id, job_type, status, filters, format, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        options.job_type,
        'pending',
        JSON.stringify(options.filters || {}),
        options.format || 'xlsx',
        options.created_by,
        new Date().toISOString()
      ]
    );

    const job = await db.get('SELECT * FROM export_jobs WHERE id = ?', [result.lastID]);

    return job;
  }

  async processJob(tenantId, jobId) {
    const db = await dbManager.getConnection(tenantId);
    
    try {
      await db.run(
        'UPDATE export_jobs SET status = ? WHERE id = ?',
        ['processing', jobId]
      );

      const job = await db.get('SELECT * FROM export_jobs WHERE id = ?', [jobId]);
      if (!job) {
        throw new Error('Job não encontrado');
      }

      const filters = JSON.parse(job.filters || '{}');
      let data = [];
      let filename = '';

      switch (job.job_type) {
        case 'persons':
          data = await this.exportPersons(db, filters);
          filename = `persons_export_${Date.now()}.${job.format}`;
          break;
        case 'visitors':
          data = await this.exportVisitors(db, filters);
          filename = `visitors_export_${Date.now()}.${job.format}`;
          break;
        case 'companies':
          data = await this.exportCompanies(db, filters);
          filename = `companies_export_${Date.now()}.${job.format}`;
          break;
        case 'all':
          data = await this.exportAll(db, filters);
          filename = `all_data_export_${Date.now()}.${job.format}`;
          break;
        default:
          throw new Error('Tipo de exportação inválido');
      }

      const filePath = join(this.exportsDir, filename);
      
      if (job.format === 'xlsx') {
        await this.exportToXLSX(data, filePath, job.job_type);
      } else {
        throw new Error('Formato não suportado');
      }

      const stats = await fs.stat(filePath);

      await db.run(
        `UPDATE export_jobs 
         SET status = ?, file_path = ?, completed_at = ?, error_message = NULL 
         WHERE id = ?`,
        ['completed', filePath, new Date().toISOString(), jobId]
      );

      logger.info(`Exportação concluída: ${filename}`, { tenantId, jobId });

      return { success: true, file_path: filePath };
    } catch (error) {
      logger.error('Erro ao processar exportação', { tenantId, jobId, error: error.message });
      
      await db.run(
        `UPDATE export_jobs 
         SET status = ?, error_message = ? 
         WHERE id = ?`,
        ['failed', error.message, jobId]
      );

      throw error;
    }
  }

  async exportPersons(db, filters) {
    let query = 'SELECT * FROM persons WHERE 1=1';
    const params = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.group_id) {
      query += ' AND group_id = ?';
      params.push(filters.group_id);
    }

    query += ' ORDER BY name ASC';
    const persons = await db.all(query, params);

    return persons.map(p => ({
      Matrícula: p.registration_number,
      Nome: p.name,
      CPF: p.cpf,
      RG: p.rg,
      'Data de Nascimento': p.birth_date,
      Gênero: p.gender,
      'Estado Civil': p.marital_status,
      Profissão: p.profession,
      Cargo: p.position,
      'Data de Admissão': p.admission_date,
      Telefone: p.phone,
      Celular: p.cellphone,
      Email: p.email,
      Endereço: p.address,
      Bairro: p.neighborhood,
      Cidade: p.city,
      Estado: p.state,
      CEP: p.cep,
      Status: p.status,
      'Consentimento LGPD': p.lgpd_consent ? 'Sim' : 'Não',
      'Data do Consentimento': p.consent_date
    }));
  }

  async exportVisitors(db, filters) {
    let query = `
      SELECT v.*, p.name as visited_person_name, c.corporate_name as visited_company_name
      FROM visitors v
      LEFT JOIN persons p ON v.visited_person_id = p.id
      LEFT JOIN companies c ON v.visited_company_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (filters.startDate) {
      query += ' AND DATE(v.entry_date) >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      query += ' AND DATE(v.entry_date) <= ?';
      params.push(filters.endDate);
    }

    if (filters.status) {
      query += ' AND v.status = ?';
      params.push(filters.status);
    }

    query += ' ORDER BY v.entry_date DESC';
    const visitors = await db.all(query, params);

    return visitors.map(v => ({
      Nome: v.name,
      Documento: v.document,
      RG: v.rg,
      Celular: v.cellphone,
      Email: v.email,
      'Empresa do Visitante': v.visitor_company,
      'Visitado (Pessoa)': v.visited_person_name,
      'Visitado (Empresa)': v.visited_company_name,
      Motivo: v.reason,
      'Data de Entrada': v.entry_date,
      'Data de Saída': v.exit_date,
      Status: v.status
    }));
  }

  async exportCompanies(db, filters) {
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params = [];

    if (filters.active !== undefined) {
      query += ' AND active = ?';
      params.push(filters.active ? 1 : 0);
    }

    query += ' ORDER BY corporate_name ASC';
    const companies = await db.all(query, params);

    return companies.map(c => ({
      'Razão Social': c.corporate_name,
      'Nome Fantasia': c.trading_name,
      CNPJ: c.cnpj,
      Telefone: c.phone,
      Email: c.email,
      Endereço: c.address,
      Status: c.active ? 'Ativo' : 'Inativo',
      'Data de Cadastro': c.created_at
    }));
  }

  async exportAll(db, filters) {
    const persons = await this.exportPersons(db, filters.persons || {});
    const visitors = await this.exportVisitors(db, filters.visitors || {});
    const companies = await this.exportCompanies(db, filters.companies || {});

    return {
      persons,
      visitors,
      companies
    };
  }

  async exportToXLSX(data, filePath, jobType) {
    const workbook = XLSX.utils.book_new();

    if (jobType === 'all' && typeof data === 'object' && !Array.isArray(data)) {
      const personsSheet = XLSX.utils.json_to_sheet(data.persons || []);
      const visitorsSheet = XLSX.utils.json_to_sheet(data.visitors || []);
      const companiesSheet = XLSX.utils.json_to_sheet(data.companies || []);

      XLSX.utils.book_append_sheet(workbook, personsSheet, 'Pessoas');
      XLSX.utils.book_append_sheet(workbook, visitorsSheet, 'Visitantes');
      XLSX.utils.book_append_sheet(workbook, companiesSheet, 'Empresas');
    } else {
      const sheet = XLSX.utils.json_to_sheet(Array.isArray(data) ? data : []);
      const sheetName = jobType === 'persons' ? 'Pessoas' :
                       jobType === 'visitors' ? 'Visitantes' :
                       jobType === 'companies' ? 'Empresas' : 'Dados';
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    }

    XLSX.writeFile(workbook, filePath);
  }
}

export default new ExportService();




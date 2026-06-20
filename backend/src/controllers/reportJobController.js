import { asyncHandler } from '../middleware/errorHandler.js';
import reportJobService from '../services/reportJobService.js';
import { existsSync } from 'fs';
import { join } from 'path';

const VALID_TYPES = ['access', 'access_por_empresa', 'vehicles', 'vehicles_por_empresa', 'persons', 'visitors', 'companies', 'encomendas'];
const VALID_FORMATS = ['pdf', 'xlsx', 'csv'];

export const createReportJob = asyncHandler(async (req, res) => {
  const { report_type, filters = {}, orientation = 'portrait' } = req.body;

  if (!report_type || !VALID_TYPES.includes(report_type)) {
    return res.status(400).json({
      success: false,
      message: `Tipo de relatório inválido. Válidos: ${VALID_TYPES.join(', ')}`
    });
  }

  if (!['portrait', 'landscape'].includes(orientation)) {
    return res.status(400).json({ success: false, message: 'Orientação inválida. Use portrait ou landscape.' });
  }

  // Formato vem dentro de filters.format ou no payload diretamente.
  // Default: pdf (compatibilidade com chamadas antigas).
  const format = (filters.format || req.body.format || 'pdf').toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    return res.status(400).json({ success: false, message: `Formato inválido. Use: ${VALID_FORMATS.join(', ')}` });
  }

  const job = await reportJobService.createJob(req.tenantId, {
    report_type,
    orientation,
    format,
    filters,
    created_by: req.user.id
  });

  // Processar em background (não awaitar)
  reportJobService.processJob(req.tenantId, job.id).catch(err => {
    console.error(`[ReportJob] Falha no job ${job.id}:`, err.message);
  });

  res.status(201).json({
    success: true,
    data: job,
    message: 'Relatório sendo gerado. Verifique o status em instantes.'
  });
});

export const listReportJobs = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const jobs = await db.all(
    `SELECT id, report_type, orientation, status, total_records, created_at, completed_at, error_message, filters, filename
     FROM report_jobs WHERE tenant_id = ?
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [req.tenantId, parseInt(limit), offset]
  );

  const { total } = await db.get(
    'SELECT COUNT(*) as total FROM report_jobs WHERE tenant_id = ?',
    [req.tenantId]
  );

  res.json({
    success: true,
    data: jobs,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
  });
});

export const getReportJobStatus = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const job = await db.get(
    `SELECT id, report_type, orientation, status, total_records, created_at, completed_at, error_message, filters, filename
     FROM report_jobs WHERE id = ? AND tenant_id = ?`,
    [id, req.tenantId]
  );

  if (!job) {
    return res.status(404).json({ success: false, message: 'Job não encontrado.' });
  }

  res.json({ success: true, data: job });
});

export const downloadReportJob = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const job = await db.get(
    `SELECT * FROM report_jobs WHERE id = ? AND tenant_id = ? AND status = 'completed'`,
    [id, req.tenantId]
  );

  if (!job || !job.file_path) {
    return res.status(404).json({ success: false, message: 'Relatório não encontrado ou ainda não concluído.' });
  }

  const filePath = job.file_path.startsWith('/') || /^[A-Z]:\\/.test(job.file_path)
    ? job.file_path
    : join(process.cwd(), job.file_path);

  if (!existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Arquivo não encontrado no servidor.' });
  }

  // Detecta extensão para download name correto
  const ext = (filePath.split('.').pop() || 'pdf').toLowerCase();
  const downloadName = job.filename || `relatorio_${job.report_type}_${job.id}.${ext}`;
  res.download(filePath, downloadName);
});

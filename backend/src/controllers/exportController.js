import { asyncHandler } from '../middleware/errorHandler.js';
import exportService from '../services/exportService.js';

export const createExport = asyncHandler(async (req, res) => {
  const { job_type, filters, format = 'xlsx' } = req.body;

  if (!job_type) {
    return res.status(400).json({
      success: false,
      message: 'Tipo de exportação é obrigatório'
    });
  }

  if (!['persons', 'visitors', 'companies', 'all'].includes(job_type)) {
    return res.status(400).json({
      success: false,
      message: 'Tipo de exportação inválido'
    });
  }

  const job = await exportService.createJob(req.tenantId, {
    job_type,
    filters: filters || {},
    format,
    created_by: req.user.id
  });

  exportService.processJob(req.tenantId, job.id).catch(error => {
    console.error('Erro ao processar job:', error);
  });

  res.status(201).json({
    success: true,
    data: job,
    message: 'Exportação iniciada. Verifique o status em alguns instantes.'
  });
});

export const listExports = asyncHandler(async (req, res) => {
  const db = req.db;
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM export_jobs WHERE tenant_id = ?';
  const params = [req.tenantId];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const jobs = await db.all(query, params);

  const countQuery = query.replace(
    /SELECT.*?FROM/s,
    'SELECT COUNT(*) as total FROM'
  ).replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: jobs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

export const getExportStatus = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const job = await db.get(
    'SELECT * FROM export_jobs WHERE id = ? AND tenant_id = ?',
    [id, req.tenantId]
  );

  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'Exportação não encontrada'
    });
  }

  res.json({
    success: true,
    data: job
  });
});

export const downloadExport = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const job = await db.get(
    'SELECT * FROM export_jobs WHERE id = ? AND tenant_id = ? AND status = ?',
    [id, req.tenantId, 'completed']
  );

  if (!job || !job.file_path) {
    return res.status(404).json({
      success: false,
      message: 'Arquivo de exportação não encontrado'
    });
  }

  const { join } = await import('path');
  const filePath = job.file_path.startsWith('/') 
    ? job.file_path 
    : join(process.cwd(), job.file_path);
  
  res.download(filePath, job.filename || `export_${id}.${job.format}`, (err) => {
    if (err) {
      console.error('Erro ao fazer download:', err);
    }
  });
});


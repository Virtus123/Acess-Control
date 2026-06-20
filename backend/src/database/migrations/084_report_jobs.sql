-- Migration 084: Tabela de fila de geração de relatórios PDF
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
);
CREATE INDEX IF NOT EXISTS idx_report_jobs_tenant ON report_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_report_jobs_status ON report_jobs(status);
CREATE INDEX IF NOT EXISTS idx_report_jobs_expires ON report_jobs(expires_at);

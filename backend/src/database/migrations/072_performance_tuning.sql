-- Migration: Performance Tuning Indexes
-- Optimizes monitoring heartbeat and search queries

-- Composite index for the monitoring heartbeat (extremely frequent)
CREATE INDEX IF NOT EXISTS idx_access_log_tenant_created_at ON access_log(tenant_id, created_at DESC);

-- Missing indexes for visitor search
CREATE INDEX IF NOT EXISTS idx_visitors_document ON visitors(document);
CREATE INDEX IF NOT EXISTS idx_visitors_cellphone ON visitors(cellphone);

-- Ensure persons indexing is complete for search
CREATE INDEX IF NOT EXISTS idx_persons_email ON persons(email);

-- Composite index for active visitors (used in stats and list)
CREATE INDEX IF NOT EXISTS idx_visitors_status_tenant ON visitors(tenant_id, status);

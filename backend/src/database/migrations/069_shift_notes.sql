-- Anotações de turno (visíveis a todos os usuários autenticados do tenant; isoladas por tenant_id)
CREATE TABLE IF NOT EXISTS shift_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  author_label TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shift_notes_tenant_created ON shift_notes(tenant_id, created_at DESC);

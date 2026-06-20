export async function migrate(db) {
  const cols = await db.all("PRAGMA table_info(audit_logs)");
  const existing = cols.map(c => c.name);

  if (!existing.includes('description')) {
    await db.run('ALTER TABLE audit_logs ADD COLUMN description TEXT');
  }
  if (!existing.includes('old_values')) {
    await db.run('ALTER TABLE audit_logs ADD COLUMN old_values TEXT');
  }
  if (!existing.includes('new_values')) {
    await db.run('ALTER TABLE audit_logs ADD COLUMN new_values TEXT');
  }
}

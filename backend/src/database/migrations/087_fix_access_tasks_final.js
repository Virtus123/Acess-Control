// Migration 087: Garante que access_tasks tem todas as colunas necessárias
// Resolve o problema de target_type e payload ausentes após restore do servidor

export async function migrate(db) {
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='access_tasks'");
    if (tables.length === 0) return;

    const cols = await db.all("PRAGMA table_info('access_tasks');");
    const existing = (cols || []).map(c => c.name);

    const required = [
        { name: 'person_id',    sql: "ALTER TABLE access_tasks ADD COLUMN person_id INTEGER;" },
        { name: 'callback_url', sql: "ALTER TABLE access_tasks ADD COLUMN callback_url TEXT;" },
        { name: 'finger_type',  sql: "ALTER TABLE access_tasks ADD COLUMN finger_type TEXT;" },
        { name: 'target_type',  sql: "ALTER TABLE access_tasks ADD COLUMN target_type TEXT;" },
        { name: 'target_id',    sql: "ALTER TABLE access_tasks ADD COLUMN target_id TEXT;" },
        { name: 'description',  sql: "ALTER TABLE access_tasks ADD COLUMN description TEXT;" },
        { name: 'payload',      sql: "ALTER TABLE access_tasks ADD COLUMN payload TEXT;" },
    ];

    for (const col of required) {
        if (!existing.includes(col.name)) {
            await db.exec(col.sql);
        }
    }
}

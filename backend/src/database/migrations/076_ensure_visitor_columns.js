import logger from '../../config/logger.js';

export async function migrate(db) {
  try {
    const required = [
      { name: 'card_number', sql: "ALTER TABLE visitors ADD COLUMN card_number TEXT;" },
      { name: 'card_type', sql: "ALTER TABLE visitors ADD COLUMN card_type TEXT DEFAULT 'manual';" },
      { name: 'liberation_type', sql: "ALTER TABLE visitors ADD COLUMN liberation_type TEXT DEFAULT 'unica';" },
      { name: 'period_start', sql: "ALTER TABLE visitors ADD COLUMN period_start DATETIME;" },
      { name: 'period_end', sql: "ALTER TABLE visitors ADD COLUMN period_end DATETIME;" },
      { name: 'expected_exit_date', sql: "ALTER TABLE visitors ADD COLUMN expected_exit_date DATETIME;" },
      { name: 'photo_base64', sql: "ALTER TABLE visitors ADD COLUMN photo_base64 TEXT;" },
      { name: 'status', sql: "ALTER TABLE visitors ADD COLUMN status TEXT DEFAULT 'on_premises';" },
      { name: 'visited_person_id', sql: "ALTER TABLE visitors ADD COLUMN visited_person_id INTEGER REFERENCES persons(id);" },
      { name: 'visited_company_id', sql: "ALTER TABLE visitors ADD COLUMN visited_company_id INTEGER REFERENCES companies(id);" },
      { name: 'face_embedding', sql: "ALTER TABLE visitors ADD COLUMN face_embedding TEXT;" },
      { name: 'registration_number', sql: "ALTER TABLE visitors ADD COLUMN registration_number TEXT;" },
      { name: 'prevent_auto_exit', sql: "ALTER TABLE visitors ADD COLUMN prevent_auto_exit INTEGER DEFAULT 0;" },
      { name: 'tenant_id', sql: "ALTER TABLE visitors ADD COLUMN tenant_id TEXT;" }
    ];

    const cols = await db.all("PRAGMA table_info('visitors');");
    const existing = (cols || []).map(c => c.name);

    for (const col of required) {
      if (!existing.includes(col.name)) {
        logger.info(`Fixing schema (076): Coluna '${col.name}' ausente em visitors — adicionando.`);
        await db.exec(col.sql);
      }
    }
    
    logger.info('Migração 076: Colunas da tabela visitors garantidas.');
  } catch (err) {
    logger.error('Erro na migração 076 (ensure_visitor_columns):', { error: err.message });
    // Não lançamos erro aqui para não travar o processo se algum outro erro ocorrer, 
    // mas o ideal é que card_number esteja disponível para a 077.
    throw err;
  }
}

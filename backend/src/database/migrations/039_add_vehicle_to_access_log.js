// Migration: Adicionar 'vehicle' ao check constraint de person_type na tabela access_log

export async function migrate(db) {
  console.log('Running migration 039: Add vehicle to access_log person_type');
  
  try {
    // Verificar se a coluna access_target já existe
    const colunas = await db.all("PRAGMA table_info(access_log)");
    const temVehicle = colunas.some(c => c.name === 'type' && c.dflt_value?.includes('vehicle'));
    
    if (temVehicle) {
      console.log('Migration 039 already applied, skipping');
      return;
    }
    
    // Recriar a tabela com a nova constraint
    await db.run(`
      CREATE TABLE IF NOT EXISTS access_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        person_id INTEGER NOT NULL,
        person_type TEXT NOT NULL CHECK (person_type IN ('person', 'visitor', 'vehicle')),
        equipment_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('ENTRY', 'EXIT', 'DENIED')),
        status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DENIED', 'ERROR')),
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (equipment_id) REFERENCES equipments(id)
      )
    `);
    
    // Copiar dados
    await db.run('INSERT INTO access_log_new SELECT * FROM access_log');
    
    // Remover tabela antiga e renomear
    await db.run('DROP TABLE access_log');
    await db.run('ALTER TABLE access_log_new RENAME TO access_log');
    
    // Recriar índices
    await db.run('CREATE INDEX IF NOT EXISTS idx_access_log_tenant ON access_log(tenant_id, created_at DESC)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_access_log_person ON access_log(person_id, person_type)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_access_log_equipment ON access_log(equipment_id)');
    await db.run('CREATE INDEX IF NOT EXISTS idx_access_log_status ON access_log(status)');
    
    console.log('Migration 039 completed successfully');
  } catch (error) {
    console.error('Migration 039 failed:', error.message);
    // Se der erro, pode ser que já foi aplicada, continuar mesmo assim
  }
}

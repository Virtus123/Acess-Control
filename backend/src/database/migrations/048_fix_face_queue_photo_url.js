// Migration 048 - Fix face_queue photo_url NOT NULL constraint

export async function migrate_048(db) {
  console.log('Running migration 048: Fix face_queue photo_url NOT NULL constraint');
  
  try {
    // Verificar se a tabela existe
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='face_queue'");
    if (tables.length === 0) {
      console.log('Table face_queue does not exist, skipping migration');
      return;
    }
    
    // Verificar constraint atual
    const tableInfo = await db.all("PRAGMA table_info(face_queue)");
    const photoUrlCol = tableInfo.find(c => c.name === 'photo_url');
    
    console.log('Current photo_url column info:', photoUrlCol);
    
    if (photoUrlCol && photoUrlCol.notnull === 1) {
      console.log('Removing NOT NULL constraint from photo_url...');
      
      // Criar nova tabela sem NOT NULL
      await db.exec('ALTER TABLE face_queue RENAME TO face_queue_old');
      
      await db.exec(`
        CREATE TABLE face_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          person_id INTEGER NOT NULL,
          person_name TEXT NOT NULL,
          person_type TEXT NOT NULL,
          photo_url TEXT,
          status TEXT DEFAULT 'pending',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // Copiar dados
      await db.exec('INSERT INTO face_queue SELECT * FROM face_queue_old');
      
      // Recriar índices
      await db.exec('CREATE INDEX IF NOT EXISTS idx_face_queue_tenant_status ON face_queue(tenant_id, status)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_face_queue_person ON face_queue(person_id, person_type)');
      
      // Remover tabela antiga
      await db.exec('DROP TABLE face_queue_old');
      
      console.log('Migration 048 completed successfully!');
    } else {
      console.log('photo_url column already allows NULL, skipping');
    }
  } catch (error) {
    console.error('Migration 048 failed:', error);
    throw error;
  }
}

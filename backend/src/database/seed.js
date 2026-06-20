import bcrypt from 'bcryptjs';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../utils/generators.js';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

async function seedAdminUser(tenantId) {
  const db = await dbManager.getConnection(tenantId);
  
  const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', ['admin@acesscontrol.com']);
  
  if (existingAdmin) {
    // Usuário admin já existe
    return;
  }

  const passwordHash = await hashPassword('admin123');
  
  await db.run(
    `INSERT INTO users (name, email, password_hash, role, active) 
     VALUES (?, ?, ?, ?, ?)`,
    [
      'Administrador',
      'admin@acesscontrol.com',
      passwordHash,
      'admin',
      1
    ]
  );
}

async function seedInitialData(tenantId) {
  await runMigrations(tenantId);
  await seedAdminUser(tenantId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tenantId = process.argv[2] || 'default';
  seedInitialData(tenantId)
    .then(() => {
      console.log(`Seed concluído para tenant: ${tenantId}`);
      console.log('Credénciais: admin@acesscontrol.com / admin123');
      process.exit(0);
    })
    .catch(error => {
      console.error('Erro ao executar seed:', error);
      process.exit(1);
    });
}

export { seedInitialData, seedAdminUser };




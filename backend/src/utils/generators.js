import crypto from 'crypto';
import argon2 from 'argon2';

export async function generateRegistrationNumber(db, prefix = '26', tableName = 'persons') {
  try {
    // Verificar se a coluna registration_number existe na tabela especificada
    const tableInfo = await db.all(`PRAGMA table_info(${tableName})`);
    const hasRegistrationNumber = tableInfo.some(col => col.name === 'registration_number');
    
    if (!hasRegistrationNumber) {
      return null;
    }

    // Busca o maior número de matrícula usando CAST e SUBSTR para ordenação numérica em vez de alfabética
    const lastRecord = await db.get(
      `SELECT registration_number FROM ${tableName} WHERE registration_number LIKE ? ORDER BY CAST(SUBSTR(registration_number, ?) AS INTEGER) DESC LIMIT 1`,
      [`${prefix}%`, prefix.length + 1]
    );

    let nextNumber = 1;

    if (lastRecord && lastRecord.registration_number) {
      // Extrair apenas o sufixo numérico
      const suffix = lastRecord.registration_number.substring(prefix.length);
      const lastNumber = parseInt(suffix, 10);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }

    // Gerar número e verificar se já existe (evita duplicatas e garante uniqueness)
    let registrationNumber = `${prefix}${String(nextNumber).padStart(4, '0')}`;
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      const existing = await db.get(
        `SELECT id FROM ${tableName} WHERE registration_number = ?`,
        [registrationNumber]
      );
      
      if (!existing) {
        break;
      }
      
      nextNumber++;
      registrationNumber = `${prefix}${String(nextNumber).padStart(4, '0')}`;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      registrationNumber = `${prefix}${Date.now()}`;
    }

    return registrationNumber;
  } catch (error) {
    throw error;
  }
}

export async function generateUniqueRandomRegistrationNumber(db, tableName = 'persons') {
  try {
    const tableInfo = await db.all(`PRAGMA table_info(${tableName})`);
    const hasRegistrationNumber = tableInfo.some(col => col.name === 'registration_number');
    
    if (!hasRegistrationNumber) {
      return null;
    }

    let registrationNumber;
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 100;

    while (!isUnique && attempts < maxAttempts) {
      // Gerar número aleatório de 6 dígitos
      registrationNumber = Math.floor(100000 + Math.random() * 900000).toString();
      
      const existing = await db.get(
        `SELECT id FROM ${tableName} WHERE registration_number = ?`,
        [registrationNumber]
      );
      
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }

    return registrationNumber;
  } catch (error) {
    console.error('Error generating random registration number:', error);
    throw error;
  }
}

export function generateFilename(prefix, extension) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

export async function hashPassword(password) {
  try {
    // Usar Argon2 para hash de senhas (mais seguro que pbkdf2/bcrypt)
    // Argon2 venceu a competição de hash de senhas PHC em 2015
    const hash = await argon2.hash(password, {
      type: argon2.argon2id, // Variante mais segura
      memoryCost: 2 ** 16,   // 64 MB
      timeCost: 3,           // 3 iterações
      parallelism: 4,        // 4 threads
      hashLength: 32
    });
    return hash;
  } catch (error) {
    // Fallback para bcrypt se argon2 falhar
    console.warn('Argon2 failed, falling back to bcrypt:', error.message);
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    // Tentar verificar com Argon2 primeiro
    if (hash.startsWith('$argon2')) {
      return await argon2.verify(hash, password);
    }
    // Fallback para pbkdf2 (formato antigo)
    if (hash.includes(':')) {
      const [salt, key] = hash.split(':');
      return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 10000, 32, 'sha256', (err, derivedKey) => {
          if (err) reject(err);
          resolve(key === derivedKey.toString('hex'));
        });
      });
    }
    // Fallback para bcrypt
    return await bcrypt.compare(password, hash);
  } catch (error) {
    console.error('Password verification error:', error.message);
    return false;
  }
}




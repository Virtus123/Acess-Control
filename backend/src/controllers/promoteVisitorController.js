// controllers/promoteVisitorController.js
// Promove um visitante para pessoa, movendo foto e dados

import { asyncHandler } from '../middleware/errorHandler.js';
import photoService from '../services/photoService.js';
import { generateRegistrationNumber } from '../utils/generators.js';
import { formatPersonData, formatPerson } from '../utils/formatters.js';
import fs from 'fs/promises';
import { join } from 'path';

// Helper: garante que a tabela person_groups existe
async function ensurePersonGroupsTable(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS person_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    UNIQUE(person_id, group_id)
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_person_groups_person ON person_groups(person_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_person_groups_group ON person_groups(group_id)');
}

// Helper: verifica colunas existentes na tabela
async function getTableColumns(db, tableName) {
  try {
    const info = await db.all(`PRAGMA table_info(${tableName})`);
    return info.map(c => c.name);
  } catch {
    return [];
  }
}

/**
 * POST /api/visitors/:id/promote
 *
 * Body esperado:
 * {
 *   company_id: number | null,
 *   group_ids:  number[],          // pode ser vazio
 *   registration_number: string    // opcional — gerado automaticamente se omitido
 * }
 *
 * O que faz:
 * 1. Lê o visitante (garante que existe)
 * 2. Move a foto de /uploads/photos/visitor → /uploads/photos/person
 * 3. Cria registro em persons com todos os dados disponíveis
 * 4. Vincula grupos e empresa
 * 5. Exclui o visitante original
 * 6. Retorna o novo registro de pessoa
 */
export const promoteVisitorToPerson = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  const { id } = req.params;
  const {
    company_id = null,
    group_ids = [],
    registration_number: regNumberOverride = null,
  } = req.body;

  // ── 1. Buscar visitante ─────────────────────────────────────────────────────
  const visitor = await db.get('SELECT * FROM visitors WHERE id = ?', [id]);
  if (!visitor) {
    return res.status(404).json({ success: false, message: 'Visitante não encontrado' });
  }

  // ── 2. Verificar se já existe pessoa com mesmo nome ativo ───────────────────
  const nameConflict = await db.get(
    "SELECT id FROM persons WHERE LOWER(name) = LOWER(?) AND status = 'active'",
    [visitor.name.trim()]
  );
  if (nameConflict) {
    return res.status(400).json({
      success: false,
      message: `Já existe uma pessoa ativa com o nome "${visitor.name}". Verifique antes de promover.`,
    });
  }

  // ── 3. Mover foto de visitor → person ───────────────────────────────────────
  let newPhotoUrl = null;

  if (visitor.photo_url) {
    try {
      const visitorPhotoFilename = visitor.photo_url.split('/').pop();
      const visitorPhotoPath = join(
        process.cwd(), 'public', 'uploads', 'photos', 'visitor', visitorPhotoFilename
      );

      // Ler arquivo original
      const photoBuffer = await fs.readFile(visitorPhotoPath);

      // Gerar nome novo no formato de pessoa (será sobrescrito abaixo após ter o ID)
      // Usa um nome temporário para processPhoto não conflitar
      const tempName = `promoted_${Date.now()}`;
      const processed = await photoService.processPhoto(
        { buffer: photoBuffer, originalname: 'photo.jpg', mimetype: 'image/jpeg' },
        'person',
        tempName,
        tenantId
      );
      newPhotoUrl = processed.url;

      // Deletar foto original do visitante
      await photoService.deletePhoto(visitorPhotoFilename, 'visitor');
    } catch (photoErr) {
      // Não abortar a promoção por causa de foto — apenas logar
      console.warn('[promote] Erro ao mover foto:', photoErr.message);
    }
  }

  // ── 4. Descobrir colunas disponíveis em persons ─────────────────────────────
  const personCols = await getTableColumns(db, 'persons');
  const has = (col) => personCols.includes(col);

  // ── 5. Usar a matrícula do visitante ──────────────────────────────────────
  // O visitante já tem uma matrícula, usamos ela diretamente
  // Se a matrícula for vazia/null, não insere o campo
  let regNumber = null;
  
  if (visitor.registration_number) {
    regNumber = visitor.registration_number;
    // Verificar se já existe alguém com essa matrícula
    const existe = await db.get('SELECT id, name FROM persons WHERE registration_number = ?', [regNumber]);
    if (existe) {
      return res.status(400).json({
        success: false,
        message: `Já existe uma pessoa com a matrícula "${regNumber}" (${existe.name}). Use outra matrícula ou edite a pessoa existente.`
      });
    }
  } else if (regNumberOverride) {
    // Se não tem matrícula do visitante, usa a fornecida pelo usuário
    regNumber = regNumberOverride;
    const existe = await db.get('SELECT id, name FROM persons WHERE registration_number = ?', [regNumber]);
    if (existe) {
      return res.status(400).json({
        success: false,
        message: `Já existe uma pessoa com a matrícula "${regNumber}" (${existe.name}). Use outra matrícula ou edite a pessoa existente.`
      });
    }
  }

  // ── 6. Montar INSERT em persons ─────────────────────────────────────────────
  const now = new Date().toISOString();

  const insertFields = ['name', 'status', 'created_at', 'updated_at'];
  const insertValues = [visitor.name, 'active', now, now];

  // Campos do visitante - usa valores existentes
  // Permite valores vazios para campos opcionais (não usa mais默认值)
  const optMap = {
    cpf: visitor.document || null,
    cellphone: visitor.cellphone || null,
    email: visitor.email || null,
    created_by: req.user?.id ?? null,
  };

  for (const [col, val] of Object.entries(optMap)) {
    if (has(col) && val != null && val !== '') {
      insertFields.push(col);
      insertValues.push(val);
    }
  }

  if (has('registration_number') && regNumber) {
    insertFields.push('registration_number');
    insertValues.push(regNumber);
  }

  if (has('photo_url') && newPhotoUrl) {
    insertFields.push('photo_url');
    insertValues.push(newPhotoUrl);
  }

  if (has('company_id') && company_id) {
    insertFields.push('company_id');
    insertValues.push(company_id);
  }

  // group_id principal = primeiro do array (compatibilidade com coluna simples)
  if (has('group_id') && group_ids.length > 0) {
    insertFields.push('group_id');
    insertValues.push(group_ids[0]);
  }

  const placeholders = insertFields.map(() => '?').join(', ');
  const result = await db.run(
    `INSERT INTO persons (${insertFields.join(', ')}) VALUES (${placeholders})`,
    insertValues
  );
  const personId = result.lastID;

  // ── 7. Renomear foto para usar o ID real da pessoa ──────────────────────────
  if (newPhotoUrl) {
    try {
      const oldFilename = newPhotoUrl.split('/').pop();
      const oldPath = join(process.cwd(), 'public', 'uploads', 'photos', 'person', oldFilename);
      const ext = oldFilename.includes('.enc') ? 'enc' : 'jpg';
      const prefix = tenantId ? `${tenantId}_` : '';
      const newFilename = `${prefix}${String(personId).padStart(6, '0')}.${ext}`;
      const newPath = join(process.cwd(), 'public', 'uploads', 'photos', 'person', newFilename);

      await fs.rename(oldPath, newPath);

      const finalUrl = `/uploads/photos/person/${newFilename}`;
      await db.run('UPDATE persons SET photo_url = ? WHERE id = ?', [finalUrl, personId]);
      newPhotoUrl = finalUrl;
    } catch (renameErr) {
      console.warn('[promote] Erro ao renomear foto:', renameErr.message);
    }
  }

  // ── 8. Vincular grupos (tabela person_groups) ───────────────────────────────
  if (group_ids.length > 0) {
    await ensurePersonGroupsTable(db);
    for (const gid of group_ids) {
      await db.run(
        'INSERT OR IGNORE INTO person_groups (person_id, group_id, created_at) VALUES (?, ?, ?)',
        [personId, gid, now]
      );
    }
  }

  // ── 9. Vincular pessoa como proprietária da empresa ─────────────────────────
  if (company_id) {
    try {
      const alreadyOwner = await db.get(
        'SELECT id FROM company_owners WHERE company_id = ? AND person_id = ?',
        [company_id, personId]
      );
      if (!alreadyOwner) {
        await db.run(
          'INSERT INTO company_owners (company_id, person_id) VALUES (?, ?)',
          [company_id, personId]
        );
      }
    } catch (ownerErr) {
      console.warn('[promote] Erro ao vincular empresa:', ownerErr.message);
    }
  }

  // ── 10. Excluir visitante original ──────────────────────────────────────────
  await db.run('DELETE FROM visitors WHERE id = ?', [id]);

  // ── 11. Buscar pessoa criada para retornar ──────────────────────────────────
  const person = await db.get('SELECT * FROM persons WHERE id = ?', [personId]);
  await ensurePersonGroupsTable(db);
  const groups = await db.all(
    'SELECT g.id, g.name FROM groups g JOIN person_groups pg ON g.id = pg.group_id WHERE pg.person_id = ?',
    [personId]
  );

  return res.status(201).json({
    success: true,
    data: formatPersonData({ ...formatPerson(person), groups, vehicles: [] }),
    message: `Visitante "${visitor.name}" promovido a pessoa com sucesso`,
  });
});
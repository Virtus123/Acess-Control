import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantDatabase } from '../middleware/tenantManager.js';
import photoService from '../services/photoService.js';

/**
 * Função helper para adicionar pessoa/visitante à fila de sync
 * Chamada pelo personController ou visitorController ao salvar com foto
 */
export async function addToFaceQueue(db, tenantId, personId, personName, personType, photoUrl) {
  try {
    // Garantir que a tabela face_queue existe
    await db.exec(`
      CREATE TABLE IF NOT EXISTS face_queue (
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
    
    // Verificar e corrigir constraint NOT NULL de photo_url
    try {
      const tableInfo = await db.all("PRAGMA table_info(face_queue)");
      const photoUrlCol = tableInfo.find(c => c.name === 'photo_url');
      if (photoUrlCol && photoUrlCol.notnull === 1) {
        // Precisa recriar a tabela para remover NOT NULL
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
        await db.exec('INSERT INTO face_queue SELECT * FROM face_queue_old');
        await db.exec('DROP TABLE face_queue_old');
      }
    } catch (e) {
      console.log('Erro ao verificar constraint:', e.message);
    }
    
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_face_queue_tenant_status ON face_queue(tenant_id, status)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_face_queue_person ON face_queue(person_id, person_type)`);
    
    // Verificar se já existe um registro pendente para esta pessoa
    const existing = await db.get(
      'SELECT id FROM face_queue WHERE tenant_id = ? AND person_id = ? AND person_type = ? AND status = ?',
      [tenantId, personId, personType, 'pending']
    );

    if (existing) {
      // Atualizar existente
      await db.run(
        'UPDATE face_queue SET person_name = ?, photo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [personName, photoUrl, existing.id]
      );
      return existing.id;
    }

    // Inserir novo registro na fila
    const result = await db.run(
      `INSERT INTO face_queue (tenant_id, person_id, person_name, person_type, photo_url, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [tenantId, personId, personName, personType, photoUrl]
    );

    return result.lastID;
  } catch (error) {
    console.error('[faceQueue] Erro ao adicionar na fila:', error);
    throw error;
  }
}

// ============================================
// ROTAS PÚBLICAS DO COMUNICADOR
// ============================================

// Rota pública para o comunicador buscar fila pendente
export const comunicadorGetQueue = asyncHandler(async (req, res) => {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id é obrigatório'
    });
  }

  try {
    // Obter conexão do banco do tenant
    const db = await getTenantDatabase(tenant_id);

    // Buscar registros pendentes
    // Faz JOIN com persons/visitors para obter registration_number (matrícula)
    const items = await db.all(
      `SELECT 
         fq.id,
         fq.person_id,
         fq.person_name,
         fq.person_type,
         fq.photo_url,
         fq.created_at,
         CASE 
           WHEN fq.person_type = 'person' THEN p.registration_number
           WHEN fq.person_type = 'visitor' THEN v.registration_number
           ELSE NULL
         END as registration_number
       FROM face_queue fq
       LEFT JOIN persons p 
         ON fq.person_type = 'person' AND fq.person_id = p.id
       LEFT JOIN visitors v 
         ON fq.person_type = 'visitor' AND fq.person_id = v.id
       WHERE fq.status = 'pending'
       ORDER BY fq.created_at ASC
       LIMIT 100`
    );

    res.json({
      success: true,
      data: items.map(item => {
        // Usar sempre a matrícula (registration_number) quando existir
        // Se não existir (tenant antigo/sem coluna), mantém o comportamento antigo com ID
        let personId;

        if (item.registration_number) {
          // converter matrícula para número inteiro, se for numérica (exigência do iDAccess/IDFace)
          const numericReg = Number(item.registration_number);
          personId = Number.isNaN(numericReg) ? item.registration_number : numericReg;
        } else {
          // Fallback: comportamento anterior
          // Visitantes recebem ID com offset de 100000 para evitar conflito com pessoas
          // Pessoa ID 1 = 1, Visitante ID 1 = 100001
          personId = item.person_type === 'visitor'
            ? item.person_id + 100000
            : item.person_id;
        }

        // Gerar URL relativa limpa (/uploads/photos/...) conforme documentação do comunicador
        let photoSignedUrl = item.photo_url;
        if (photoSignedUrl) {
          photoSignedUrl = photoService.generatePublicUrl(photoSignedUrl, item.person_type);
        }

        return {
          id: item.id,
          personId,
          personName: item.person_name,
          personType: item.person_type,
          photoUrl: photoSignedUrl,
          createdAt: item.created_at
        };
      })
    });
  } catch (error) {
    console.error('[comunicadorGetQueue] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar fila'
    });
  }
});

// Rota pública para o comunicador marcar como processado (enviado ao equipamento)
export const comunicadorMarkProcessed = asyncHandler(async (req, res) => {
  const { tenant_id, queue_id } = req.body;

  if (!tenant_id || !queue_id) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id e queue_id são obrigatórios'
    });
  }

  try {
    const db = await getTenantDatabase(tenant_id);

    // Buscar o item na fila
    const item = await db.get('SELECT * FROM face_queue WHERE id = ?', [queue_id]);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item não encontrado na fila'
      });
    }

    // Marcar como processado
    await db.run(
      'UPDATE face_queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['processed', queue_id]
    );

    res.json({
      success: true,
      message: 'Item processado com sucesso'
    });
  } catch (error) {
    console.error('[comunicadorMarkProcessed] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao processar item'
    });
  }
});

// Rota pública para o comunicador marcar como erro
export const comunicadorMarkError = asyncHandler(async (req, res) => {
  const { tenant_id, queue_id, error_message } = req.body;

  if (!tenant_id || !queue_id) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id e queue_id são obrigatórios'
    });
  }

  try {
    const db = await getTenantDatabase(tenant_id);

    await db.run(
      'UPDATE face_queue SET status = ?, error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['error', error_message || 'Erro desconhecido', queue_id]
    );

    res.json({
      success: true,
      message: 'Item marcado como erro'
    });
  } catch (error) {
    console.error('[comunicadorMarkError] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao marcar item como erro'
    });
  }
});

// Rota pública para o equipamento enviar status online/offline
export const comunicadorEquipmentStatus = asyncHandler(async (req, res) => {
  const { tenant_id, equip_validator, online, ip_address, last_ping } = req.body;

  if (!tenant_id || !equip_validator) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id e equip_validator são obrigatórios'
    });
  }

  try {
    const db = await getTenantDatabase(tenant_id);

    // Buscar equipamento pelo validador
    const equipment = await db.get(
      'SELECT * FROM equipments WHERE validador = ?',
      [equip_validator]
    );

    if (!equipment) {
      return res.status(404).json({
        success: false,
        message: 'Equipamento não encontrado'
      });
    }

    // Atualizar status online e último ping (sem alterar IP se não for enviado)
    if (ip_address) {
      await db.run(
        'UPDATE equipments SET online = ?, last_connection = ?, ip_address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [online ? 1 : 0, last_ping || new Date().toISOString(), ip_address, equipment.id]
      );
    } else {
      await db.run(
        'UPDATE equipments SET online = ?, last_connection = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [online ? 1 : 0, last_ping || new Date().toISOString(), equipment.id]
      );
    }

    res.json({
      success: true,
      message: online ? 'Equipamento online' : 'Equipamento offline'
    });
  } catch (error) {
    console.error('[comunicadorEquipmentStatus] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao atualizar status do equipamento'
    });
  }
});

// Rota pública para o comunicador buscar todos os equipamentos de um tenant
export const comunicadorGetEquipments = asyncHandler(async (req, res) => {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id é obrigatório'
    });
  }

  try {
    const db = await getTenantDatabase(tenant_id);

    if (!db) {
      return res.status(404).json({
        success: false,
        message: 'Tenant não encontrado'
      });
    }

    const equipments = await db.all(
      'SELECT * FROM equipments WHERE active = 1 ORDER BY name'
    );

    const formattedEquipments = equipments.map(equip => ({
      id: equip.id,
      equipId: equip.equip_id,
      name: equip.name,
      marca: equip.marca,
      modelo: equip.modelo,
      ipAddress: equip.ip_address,
      port: equip.port,
      tipo: equip.tipo,
      validador: equip.validador,
      usuario: equip.usuario,
      senha: equip.senha,
      serial: equip.serial,
      controlaEstacionamento: equip.controla_estacionamento === 1,
      is_exit: equip.equipamento_saida === 1,
      inativar_visitante: equip.inativar_visitante === 1,
      localizacao: equip.localizacao,
      descricao: equip.descricao,
      status: equip.status,
      online: equip.online === 1,
      active: equip.active === 1
    }));

    res.json({
      success: true,
      data: formattedEquipments,
      count: formattedEquipments.length
    });
  } catch (error) {
    console.error('[comunicadorGetEquipments] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar equipamentos'
    });
  }
});

// Rota pública para limpar a fila de um tenant
export const comunicadorClearQueue = asyncHandler(async (req, res) => {
  const { tenant_id } = req.query;

  if (!tenant_id) {
    return res.status(400).json({
      success: false,
      message: 'tenant_id é obrigatório'
    });
  }

  try {
    const db = await getTenantDatabase(tenant_id);

    if (!db) {
      return res.status(404).json({
        success: false,
        message: 'Tenant não encontrado'
      });
    }

    // Limpar todos os registros da fila
    const result = await db.run('DELETE FROM face_queue');

    res.json({
      success: true,
      message: `Fila limpa. ${result.changes} registros removidos.`
    });
  } catch (error) {
    console.error('[comunicadorClearQueue] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao limpar a fila'
    });
  }
});

// ============================================
// ROTAS PROTEGIDAS (Frontend)
// ============================================

// Listar fotos pendentes da fila (protegida - para frontend)
export const listPending = asyncHandler(async (req, res) => {
  const db = req.db;
  const { limit = 50 } = req.query;
  const tenantId = req.tenantId;

  const items = await db.all(
    `SELECT fq.*, 
            CASE WHEN fq.person_type = 'person' THEN p.name ELSE v.name END as person_name_calc
     FROM face_queue fq 
     LEFT JOIN persons p ON fq.person_type = 'person' AND fq.person_id = p.id 
     LEFT JOIN visitors v ON fq.person_type = 'visitor' AND fq.person_id = v.id 
     WHERE fq.tenant_id = ? AND fq.status = 'pending' 
     ORDER BY fq.created_at ASC 
     LIMIT ?`,
    [tenantId, parseInt(limit)]
  );

  res.json({
    success: true,
    data: items.map(item => ({
      id: item.id,
      personId: item.person_id,
      personName: item.person_name,
      personType: item.person_type,
      photoUrl: item.photo_url,
      status: item.status,
      createdAt: item.created_at
    }))
  });
});

// Marcar item como processado (protegida)
export const markProcessed = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const tenantId = req.tenantId;

  const item = await db.get(
    'SELECT * FROM face_queue WHERE id = ? AND tenant_id = ?',
    [id, tenantId]
  );

  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item não encontrado na fila'
    });
  }

  await db.run(
    'UPDATE face_queue SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
    ['processed', id]
  );

  res.json({
    success: true,
    message: 'Item processado com sucesso'
  });
});

// Marcar item como erro (protegida)
export const markError = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { error_message } = req.body;
  const tenantId = req.tenantId;

  await db.run(
    'UPDATE face_queue SET status = ?, error_message = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?',
    ['error', error_message || 'Erro desconhecido', id, tenantId]
  );

  res.json({
    success: true,
    message: 'Item marcado como erro'
  });
});

// Listar histórico de processamento (protegida)
export const listHistory = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 50, status } = req.query;
  const offset = (page - 1) * limit;
  const tenantId = req.tenantId;

  let query = `
    SELECT fq.*, 
           CASE WHEN fq.person_type = 'person' THEN p.name ELSE v.name END as person_name_calc
    FROM face_queue fq 
    LEFT JOIN persons p ON fq.person_type = 'person' AND fq.person_id = p.id 
    LEFT JOIN visitors v ON fq.person_type = 'visitor' AND fq.person_id = v.id 
    WHERE fq.tenant_id = ?
  `;
  const params = [tenantId];

  if (status) {
    query += ' AND fq.status = ?';
    params.push(status);
  }

  query += ' ORDER BY fq.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const items = await db.all(query, params);

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: items.map(item => ({
      id: item.id,
      personId: item.person_id,
      personName: item.person_name,
      personType: item.person_type,
      photoUrl: item.photo_url,
      status: item.status,
      errorMessage: item.error_message,
      createdAt: item.created_at,
      processedAt: item.processed_at
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

// Adicionar manualmente à fila (protegida)
export const addToQueue = asyncHandler(async (req, res) => {
  const db = req.db;
  const { person_id, person_name, person_type, photo_url } = req.body;
  const tenantId = req.tenantId;

  // Foto não é mais obrigatória - pessoas sem foto também entram na fila

  const id = await addToFaceQueue(db, tenantId, person_id, person_name, person_type || 'person', photo_url);

  res.status(201).json({
    success: true,
    message: 'Cadastro adicionado na fila para sync',
    data: {
      id: id,
      status: 'pending'
    }
  });
});

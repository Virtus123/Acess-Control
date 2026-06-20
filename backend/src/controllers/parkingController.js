import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

export const list = asyncHandler(async (req, res) => {
  const db = req.db;
  const { page = 1, limit = 10, search, type, active } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM parkings WHERE 1=1';
  const params = [];

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  }

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (search) {
    query += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }

  query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  const parkings = await db.all(query, params);

  // Para cada estacionamento, contar vagas (fixo) ou usar total_spots (rotativo)
  const enrichedParkings = await Promise.all(
    parkings.map(async (parking) => {
      if (parking.type === 'fixo') {
        const spotsCount = await db.get(
          'SELECT COUNT(*) as total FROM parking_spots WHERE parking_id = ?',
          [parking.id]
        );
        const occupiedCount = await db.get(
          'SELECT COUNT(*) as occupied FROM parking_spots WHERE parking_id = ? AND status = ?',
          [parking.id, 'occupied']
        );
        // Buscar vagas disponíveis para listagem
        const availableSpots = await db.all(
          'SELECT id, spot_number, status FROM parking_spots WHERE parking_id = ? ORDER BY spot_number',
          [parking.id]
        );
        return {
          ...parking,
          total_spots: spotsCount ? spotsCount.total : 0,
          occupied_spots: occupiedCount ? occupiedCount.occupied : 0,
          available_spots: (spotsCount ? spotsCount.total : 0) - (occupiedCount ? occupiedCount.occupied : 0),
          spots: availableSpots || []
        };
      } else {
        // Rotativo: usar total_spots ou mostrar "Sem limite" se null/9999
        const total = parking.total_spots;
        return {
          ...parking,
          total_spots: total,
          occupied_spots: null,
          available_spots: null,
          display_spots: total === 9999 || !total ? null : total,
          spots: []
        };
      }
    })
  );

  const countQuery = query.replace(/SELECT.*?FROM/s, 'SELECT COUNT(*) as total FROM').replace(/ORDER BY.*/, '').replace(/LIMIT.*/, '');
  const countParams = params.slice(0, -2);
  const { total } = await db.get(countQuery, countParams);

  res.json({
    success: true,
    data: enrichedParkings.map(formatParking),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total,
      totalPages: Math.ceil(total / limit)
    }
  });
});

export const getById = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const parking = await db.get('SELECT * FROM parkings WHERE id = ?', [id]);

  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  let spots = [];
  if (parking.type === 'fixo') {
    spots = await db.all(
      'SELECT * FROM parking_spots WHERE parking_id = ? ORDER BY spot_number ASC',
      [id]
    );
  }

  const formatted = formatParking(parking);
  
  res.json({
    success: true,
    data: {
      ...formatted,
      spots: spots
    }
  });
});

export const create = asyncHandler(async (req, res) => {
  const db = req.db;
  const { name, type, total_spots, empresas } = req.body;

  if (!name || !type) {
    return res.status(400).json({
      success: false,
      message: 'Nome e tipo são obrigatórios'
    });
  }

  if (!['rotativo', 'fixo'].includes(type)) {
    return res.status(400).json({
      success: false,
      message: 'Tipo deve ser "rotativo" ou "fixo"'
    });
  }

  // Para rotativo: se não especificar vagas, usar 9999 (ilimitado)
  let spots = total_spots;
  if (type === 'rotativo' && (!spots || spots === '')) {
    spots = 9999;
  }

  // Converter empresas para JSON string se existir
  const empresasJson = empresas ? JSON.stringify(empresas) : null;

  const result = await db.run(
    'INSERT INTO parkings (name, type, total_spots, created_by, active, empresas) VALUES (?, ?, ?, ?, ?, ?)',
    [name, type, spots || null, req.user.id, 1, empresasJson]
  );

  const parking = await db.get('SELECT * FROM parkings WHERE id = ?', [result.lastID]);

  res.status(201).json({
    success: true,
    data: formatParking(parking),
    message: 'Estacionamento criado com sucesso'
  });

  // Log audit
  await auditService.logCreate(req, 'parking', parking.id, `Criação de estacionamento: ${parking.name}`, parking);
});

export const update = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { name, type, total_spots, active, empresas } = req.body;

  const parking = await db.get('SELECT id, type FROM parkings WHERE id = ?', [id]);
  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  const fields = [];
  const values = [];

  if (name) {
    fields.push('name = ?');
    values.push(name);
  }

  if (type && ['rotativo', 'fixo'].includes(type)) {
    // Se mudou de fixo para rotativo, remover todas as vagas
    if (parking.type === 'fixo' && type === 'rotativo') {
      await db.run('DELETE FROM parking_spots WHERE parking_id = ?', [id]);
    }
    
    fields.push('type = ?');
    values.push(type);
  }

  if (total_spots !== undefined) {
    let spots = total_spots;
    // Para rotativo: se não especificar vagas, usar 9999 (ilimitado)
    if (type === 'rotativo' && (!spots || spots === '')) {
      spots = 9999;
    }
    fields.push('total_spots = ?');
    values.push(spots || null);
  }

  if (active !== undefined) {
    fields.push('active = ?');
    values.push(active ? 1 : 0);
  }

  // Salvar distribuição de vagas por empresa
  if (empresas !== undefined) {
    const empresasJson = empresas ? JSON.stringify(empresas) : null;
    fields.push('empresas = ?');
    values.push(empresasJson);
  }

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  if (fields.length <= 1) {
    return res.status(400).json({
      success: false,
      message: 'Nenhum campo para atualizar'
    });
  }

  await db.run(`UPDATE parkings SET ${fields.join(', ')} WHERE id = ?`, values);

  const updatedParking = await db.get('SELECT * FROM parkings WHERE id = ?', [id]);

  res.json({
    success: true,
    data: formatParking(updatedParking),
    message: 'Estacionamento atualizado com sucesso'
  });

  // Log audit
  await auditService.logUpdate(req, 'parking', id, `Atualização de estacionamento: ${updatedParking.name}`, parking, updatedParking);
});

export const remove = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const parking = await db.get('SELECT id FROM parkings WHERE id = ?', [id]);
  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  // Remover vagas associadas (CASCADE já faz isso, mas vamos garantir)
  await db.run('DELETE FROM parking_spots WHERE parking_id = ?', [id]);

  // Remover estacionamento
  await db.run('DELETE FROM parkings WHERE id = ?', [id]);

  res.json({
    success: true,
    message: 'Estacionamento removido com sucesso'
  });

  // Log audit
  await auditService.logDelete(req, 'parking', id, `Exclusão de estacionamento: ${parking.name || id}`, parking);
});

// Gerenciamento de vagas (apenas para fixo)
export const getSpots = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;

  const parking = await db.get('SELECT id, type FROM parkings WHERE id = ?', [id]);
  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  if (parking.type !== 'fixo') {
    return res.status(400).json({
      success: false,
      message: 'Apenas estacionamentos fixos têm vagas individuais'
    });
  }

  const spots = await db.all(
    'SELECT * FROM parking_spots WHERE parking_id = ? ORDER BY spot_number ASC',
    [id]
  );

  res.json({
    success: true,
    data: spots
  });
});

export const createSpots = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id } = req.params;
  const { spot_number, start_number, end_number, prefix } = req.body;

  const parking = await db.get('SELECT id, type FROM parkings WHERE id = ?', [id]);
  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  if (parking.type !== 'fixo') {
    return res.status(400).json({
      success: false,
      message: 'Apenas estacionamentos fixos podem ter vagas cadastradas'
    });
  }

  // Cadastro em massa (de start_number a end_number)
  if (start_number !== undefined && end_number !== undefined) {
    const start = parseInt(start_number);
    const end = parseInt(end_number);

    if (isNaN(start) || isNaN(end) || start > end) {
      return res.status(400).json({
        success: false,
        message: 'Números de vaga inválidos'
      });
    }

    const created = [];
    for (let num = start; num <= end; num++) {
      try {
        // Se tem prefixo, usa prefixo + número, senão usa apenas o número
        const spotNum = prefix ? `${prefix} ${num}` : num.toString();
        await db.run(
          'INSERT INTO parking_spots (parking_id, spot_number, status) VALUES (?, ?, ?)',
          [id, spotNum, 'available']
        );
        created.push(spotNum);
      } catch (error) {
        // Vaga já existe, pular
        console.warn(`Vaga ${num} já existe`);
      }
    }

    return res.status(201).json({
      success: true,
      message: `${created.length} vagas criadas com sucesso`,
      data: { created: created.length }
    });
  }

  // Cadastro único
  if (!spot_number) {
    return res.status(400).json({
      success: false,
      message: 'Número da vaga é obrigatório'
    });
  }

  const existing = await db.get(
    'SELECT id FROM parking_spots WHERE parking_id = ? AND spot_number = ?',
    [id, spot_number]
  );

  if (existing) {
    return res.status(400).json({
      success: false,
      message: 'Vaga já cadastrada'
    });
  }

  const result = await db.run(
    'INSERT INTO parking_spots (parking_id, spot_number, status) VALUES (?, ?, ?)',
    [id, spot_number, 'available']
  );

  const spot = await db.get('SELECT * FROM parking_spots WHERE id = ?', [result.lastID]);

  res.status(201).json({
    success: true,
    data: spot,
    message: 'Vaga criada com sucesso'
  });
});

export const deleteSpot = asyncHandler(async (req, res) => {
  const db = req.db;
  const { id, spotId } = req.params;

  const parking = await db.get('SELECT id FROM parkings WHERE id = ?', [id]);
  if (!parking) {
    return res.status(404).json({
      success: false,
      message: 'Estacionamento não encontrado'
    });
  }

  await db.run('DELETE FROM parking_spots WHERE id = ? AND parking_id = ?', [spotId, id]);

  res.json({
    success: true,
    message: 'Vaga removida com sucesso'
  });
});

function formatParking(parking) {
  // Parse empresas JSON se existir
  let empresas = null;
  if (parking.empresas) {
    try {
      empresas = JSON.parse(parking.empresas);
    } catch (e) {
      console.error('Erro ao fazer parse do campo empresas:', e);
      empresas = null;
    }
  }
  
  return {
    id: parking.id,
    name: parking.name,
    type: parking.type,
    total_spots: parking.total_spots === 9999 ? null : parking.total_spots,
    active: Boolean(parking.active),
    empresas: empresas,
    // Incluir campos de vagas se existirem
    spots: parking.spots || [],
    occupied_spots: parking.occupied_spots || null,
    available_spots: parking.available_spots || null,
    created_at: parking.created_at,
    updated_at: parking.updated_at
  };
}

import { asyncHandler } from '../middleware/errorHandler.js';
import dbManager from '../config/database.js';

// Helper: retorna conexão com o banco master onde ficam as tabelas de preços
async function getMasterDb() {
  return dbManager.getConnection('mamcontrolmam');
}

// Get all price tables
export const getPriceTables = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  try {
    const tables = await db.all('SELECT * FROM price_tables ORDER BY id');
    for (let table of tables) {
      table.ranges = await db.all(
        'SELECT * FROM price_ranges WHERE price_table_id = ? ORDER BY entity_type, min_quantity',
        [table.id]
      );
    }
    res.json({ success: true, data: tables });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

// Get single price table
export const getPriceTable = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  const { id } = req.params;
  try {
    const table = await db.get('SELECT * FROM price_tables WHERE id = ?', [id]);
    if (!table) return res.status(404).json({ success: false, message: 'Tabela de preços não encontrada' });
    table.ranges = await db.all(
      'SELECT * FROM price_ranges WHERE price_table_id = ? ORDER BY entity_type, min_quantity',
      [id]
    );
    res.json({ success: true, data: table });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

// Create price table
export const createPriceTable = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  const { name, description, ranges } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Nome é obrigatório' });
  try {
    const result = await db.run(
      'INSERT INTO price_tables (name, description) VALUES (?, ?)',
      [name, description || null]
    );
    const tableId = result.lastID;
    if (ranges && Array.isArray(ranges)) {
      for (const range of ranges) {
        await db.run(
          'INSERT INTO price_ranges (price_table_id, entity_type, min_quantity, max_quantity, price, is_incremental) VALUES (?, ?, ?, ?, ?, ?)',
          [tableId, range.entity_type, range.min_quantity, range.max_quantity ?? null, range.price, range.is_incremental ? 1 : 0]
        );
      }
    }
    res.json({ success: true, message: 'Tabela de preços criada com sucesso', data: { id: tableId } });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

// Update price table
export const updatePriceTable = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  const { id } = req.params;
  const { name, description, ranges } = req.body;
  try {
    const table = await db.get('SELECT * FROM price_tables WHERE id = ?', [id]);
    if (!table) return res.status(404).json({ success: false, message: 'Tabela de preços não encontrada' });
    await db.run(
      'UPDATE price_tables SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name || table.name, description !== undefined ? description : table.description, id]
    );
    if (ranges && Array.isArray(ranges)) {
      await db.run('DELETE FROM price_ranges WHERE price_table_id = ?', [id]);
      for (const range of ranges) {
        await db.run(
          'INSERT INTO price_ranges (price_table_id, entity_type, min_quantity, max_quantity, price, is_incremental) VALUES (?, ?, ?, ?, ?, ?)',
          [id, range.entity_type, range.min_quantity, range.max_quantity ?? null, range.price, range.is_incremental ? 1 : 0]
        );
      }
    }
    res.json({ success: true, message: 'Tabela de preços atualizada com sucesso' });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

// Delete price table
export const deletePriceTable = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  const { id } = req.params;
  try {
    const table = await db.get('SELECT * FROM price_tables WHERE id = ?', [id]);
    if (!table) return res.status(404).json({ success: false, message: 'Tabela de preços não encontrada' });
    await db.run('DELETE FROM price_ranges WHERE price_table_id = ?', [id]);
    await db.run('DELETE FROM price_tables WHERE id = ?', [id]);
    res.json({ success: true, message: 'Tabela de preços excluída com sucesso' });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

// Calculate price for given quantities (used for simulations)
export const calculatePrice = asyncHandler(async (req, res) => {
  const db = await getMasterDb();
  const { pessoas, equipamentos } = req.body;
  try {
    // Pegar a primeira tabela ativa ou qualquer uma se não houver ativa
    let priceTable = await db.get('SELECT * FROM price_tables WHERE is_active = 1 LIMIT 1');
    if (!priceTable) {
        priceTable = await db.get('SELECT * FROM price_tables LIMIT 1');
    }
    
    if (!priceTable) return res.status(404).json({ success: false, message: 'Nenhuma tabela de preços cadastrada' });
    
    const ranges = await db.all('SELECT * FROM price_ranges WHERE price_table_id = ? ORDER BY entity_type, min_quantity', [priceTable.id]);
    
    let totalPrice = 0;
    const breakdown = [];

    const calculateRules = (qty, type, label) => {
      const typeRanges = ranges.filter(r => r.entity_type === type);
      if (qty <= 0 || typeRanges.length === 0) return;

      // 1. Achar a base (incremental = 0)
      const baseRule = typeRanges.find(r => 
          !r.is_incremental && 
          qty >= r.min_quantity && 
          (r.max_quantity === null || qty <= r.max_quantity)
      );

      if (baseRule) {
          totalPrice += baseRule.price;
          breakdown.push({ 
              description: `${label} (Base: ${qty})`, 
              value: baseRule.price 
          });
      }

      // 2. Somar adicionais incrementais (incremental = 1)
      const incrementalRules = typeRanges.filter(r => 
          r.is_incremental && qty >= r.min_quantity
      );

      incrementalRules.forEach(r => {
          totalPrice += r.price;
          breakdown.push({ 
              description: `${label} (Adicional: ${r.min_quantity})`, 
              value: r.price 
          });
      });
    };

    calculateRules(pessoas || 0, 'pessoas', 'Pessoas');
    calculateRules(equipamentos || 0, 'equipamentos', 'Equipamentos');

    res.json({ 
        success: true, 
        data: { 
            table_name: priceTable.name, 
            pessoas, 
            equipamentos, 
            breakdown, 
            total_price: totalPrice 
        } 
    });
  } finally {
    await dbManager.closeConnection('mamcontrolmam');
  }
});

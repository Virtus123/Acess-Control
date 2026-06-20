import dbManager from '../config/database.js';
import logger from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

// Helper para obter conexão do banco
async function getDb(tenantId) {
    return await dbManager.getConnection(tenantId);
}

export const list = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const schedules = await db.all(
        `SELECT * FROM schedules WHERE tenant_id = ? ORDER BY name ASC`,
        [tenantId]
    );
    
    // Buscar os ranges para cada schedule
    for (const schedule of schedules) {
        const ranges = await db.all(
            `SELECT * FROM schedule_ranges WHERE schedule_id = ?`,
            [schedule.id]
        );
        schedule.ranges = ranges;
    }
    
    res.json({
        success: true,
        data: schedules
    });
});

export const getById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const schedule = await db.get(
        `SELECT * FROM schedules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!schedule) {
        return res.status(404).json({
            success: false,
            message: 'Horário não encontrado'
        });
    }
    
    // Get schedule time ranges
    const ranges = await db.all(
        `SELECT * FROM schedule_ranges WHERE schedule_id = ?`,
        [id]
    );
    
    res.json({
        success: true,
        data: { ...schedule, ranges }
    });
});

export const create = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    const { name, type, description, ranges } = req.body;
    
    const result = await db.run(
        `INSERT INTO schedules (tenant_id, name, type, description, created_at) 
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [tenantId, name, type || 'general', description || null]
    );
    
    const scheduleId = result.lastID;
    
    // Insert time ranges if provided
    if (ranges && Array.isArray(ranges)) {
        for (const range of ranges) {
            await db.run(
                `INSERT INTO schedule_ranges (schedule_id, day_of_week, start_time, end_time) 
                 VALUES (?, ?, ?, ?)`,
                [scheduleId, range.day_of_week, range.start_time, range.end_time]
            );
        }
    }
    
    logger.info(`Horário criado: ${name} para tenant ${tenantId}`);
    
    res.status(201).json({
        success: true,
        data: {
            id: scheduleId,
            tenant_id: tenantId,
            name,
            type: type || 'general',
            description,
            ranges
        }
    });
});

export const update = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    const { name, type, description, ranges } = req.body;
    
    const existing = await db.get(
        `SELECT * FROM schedules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!existing) {
        return res.status(404).json({
            success: false,
            message: 'Horário não encontrado'
        });
    }
    
    await db.run(
        `UPDATE schedules SET name = ?, type = ?, description = ?, updated_at = datetime('now')
         WHERE id = ? AND tenant_id = ?`,
        [name, type, description, id, tenantId]
    );
    
    // Update ranges if provided
    if (ranges && Array.isArray(ranges)) {
        // Delete existing ranges
        await db.run(`DELETE FROM schedule_ranges WHERE schedule_id = ?`, [id]);
        
        // Insert new ranges
        for (const range of ranges) {
            await db.run(
                `INSERT INTO schedule_ranges (schedule_id, day_of_week, start_time, end_time) 
                 VALUES (?, ?, ?, ?)`,
                [id, range.day_of_week, range.start_time, range.end_time]
            );
        }
    }
    
    logger.info(`Horário atualizado: ${id} para tenant ${tenantId}`);
    
    res.json({
        success: true,
        data: { id, name, type, description, ranges }
    });
});

export const deleteSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const existing = await db.get(
        `SELECT * FROM schedules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!existing) {
        return res.status(404).json({
            success: false,
            message: 'Horário não encontrado'
        });
    }
    
    // Delete ranges first
    await db.run(`DELETE FROM schedule_ranges WHERE schedule_id = ?`, [id]);
    
    // Delete schedule
    await db.run(`DELETE FROM schedules WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
    
    logger.info(`Horário deletado: ${id} para tenant ${tenantId}`);
    
    res.json({
        success: true,
        message: 'Horário deletado com sucesso'
    });
});

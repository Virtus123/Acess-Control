import logger from '../config/logger.js';

class HolidayController {
    async getAll(req, res) {
        try {
            const db = req.db;
            const tenantId = req.tenantId;
            const holidays = await db.all(
                `SELECT * FROM holidays WHERE tenant_id = ? ORDER BY date ASC`,
                [tenantId]
            );
            
            res.json({
                success: true,
                data: holidays
            });
        } catch (error) {
            logger.error('Erro ao buscar feriados:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar feriados'
            });
        }
    }

    async getById(req, res) {
        try {
            const db = req.db;
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const holiday = await db.get(
                `SELECT * FROM holidays WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!holiday) {
                return res.status(404).json({
                    success: false,
                    message: 'Feriado não encontrado'
                });
            }
            
            res.json({
                success: true,
                data: holiday
            });
        } catch (error) {
            logger.error('Erro ao buscar feriado:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar feriado'
            });
        }
    }

    async create(req, res) {
        try {
            const db = req.db;
            const tenantId = req.tenantId;
            const { name, date, type, description } = req.body;
            
            const result = await db.run(
                `INSERT INTO holidays (tenant_id, name, date, type, repeat_annual, description, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
                [tenantId, name, date, type || 'national', req.body.repeat_annual ? 1 : 0, description || null]
            );
            
            logger.info(`Feriado criado: ${name} para tenant ${tenantId}`);
            
            res.status(201).json({
                success: true,
                data: {
                    id: result.id,
                    tenant_id: tenantId,
                    name,
                    date,
                    type: type || 'national',
                    description
                }
            });
        } catch (error) {
            logger.error('Erro ao criar feriado:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar feriado'
            });
        }
    }

    async update(req, res) {
        try {
            const db = req.db;
            const { id } = req.params;
            const tenantId = req.tenantId;
            const { name, date, type, description } = req.body;
            
            const existing = await db.get(
                `SELECT * FROM holidays WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Feriado não encontrado'
                });
            }
            
            await db.run(
                `UPDATE holidays SET name = ?, date = ?, type = ?, repeat_annual = ?, description = ?, updated_at = datetime('now')
                 WHERE id = ? AND tenant_id = ?`,
                [name, date, type, req.body.repeat_annual ? 1 : 0, description, id, tenantId]
            );
            
            logger.info(`Feriado atualizado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                data: { id, name, date, type, description }
            });
        } catch (error) {
            logger.error('Erro ao atualizar feriado:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar feriado'
            });
        }
    }

    async delete(req, res) {
        try {
            const db = req.db;
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const existing = await db.get(
                `SELECT * FROM holidays WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Feriado não encontrado'
                });
            }
            
            await db.run(
                `DELETE FROM holidays WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            logger.info(`Feriado deletado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                message: 'Feriado deletado com sucesso'
            });
        } catch (error) {
            logger.error('Erro ao deletar feriado:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao deletar feriado'
            });
        }
    }
}

export default new HolidayController();

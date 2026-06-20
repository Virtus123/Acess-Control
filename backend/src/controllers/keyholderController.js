import db from '../config/database.js';
import logger from '../config/logger.js';

class KeyholderController {
    async getAll(req, res) {
        try {
            const tenantId = req.tenantId;
            const keyholders = await db.all(
                `SELECT * FROM keyholders WHERE tenant_id = ? ORDER BY name ASC`,
                [tenantId]
            );
            
            res.json({
                success: true,
                data: keyholders
            });
        } catch (error) {
            logger.error('Erro ao buscar claviculário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar claviculário'
            });
        }
    }

    async getById(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const keyholder = await db.get(
                `SELECT * FROM keyholders WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!keyholder) {
                return res.status(404).json({
                    success: false,
                    message: 'Claviculário não encontrado'
                });
            }
            
            res.json({
                success: true,
                data: keyholder
            });
        } catch (error) {
            logger.error('Erro ao buscar claviculário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar claviculário'
            });
        }
    }

    async create(req, res) {
        try {
            const tenantId = req.tenantId;
            const { name, location, capacity, description, active } = req.body;
            
            const result = await db.run(
                `INSERT INTO keyholders (tenant_id, name, location, capacity, description, active, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
                [tenantId, name, location || null, capacity || null, description || null, active ? 1 : 0]
            );
            
            logger.info(`Claviculário criado: ${name} para tenant ${tenantId}`);
            
            res.status(201).json({
                success: true,
                data: {
                    id: result.id,
                    tenant_id: tenantId,
                    name,
                    location,
                    capacity,
                    description,
                    active: active ? 1 : 0
                }
            });
        } catch (error) {
            logger.error('Erro ao criar claviculário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar claviculário'
            });
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            const { name, location, capacity, description, active } = req.body;
            
            const existing = await db.get(
                `SELECT * FROM keyholders WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Claviculário não encontrado'
                });
            }
            
            await db.run(
                `UPDATE keyholders SET name = ?, location = ?, capacity = ?, description = ?, active = ?, updated_at = datetime('now')
                 WHERE id = ? AND tenant_id = ?`,
                [name, location, capacity, description, active ? 1 : 0, id, tenantId]
            );
            
            logger.info(`Claviculário atualizado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                data: { id, name, location, capacity, description, active: active ? 1 : 0 }
            });
        } catch (error) {
            logger.error('Erro ao atualizar claviculário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar claviculário'
            });
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const existing = await db.get(
                `SELECT * FROM keyholders WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Claviculário não encontrado'
                });
            }
            
            await db.run(
                `DELETE FROM keyholders WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            logger.info(`Claviculário deletado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                message: 'Claviculário deletado com sucesso'
            });
        } catch (error) {
            logger.error('Erro ao deletar claviculário:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao deletar claviculário'
            });
        }
    }
}

export default new KeyholderController();

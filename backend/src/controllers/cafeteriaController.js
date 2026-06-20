import db from '../config/database.js';
import logger from '../config/logger.js';
import auditService from '../services/auditService.js';

class CafeteriaController {
    async getAll(req, res) {
        try {
            const tenantId = req.tenantId;
            const cafeterias = await db.all(
                `SELECT * FROM cafeterias WHERE tenant_id = ? ORDER BY name ASC`,
                [tenantId]
            );
            
            res.json({
                success: true,
                data: cafeterias
            });
        } catch (error) {
            logger.error('Erro ao buscar refeitórios:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar refeitórios'
            });
        }
    }

    async getById(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const cafeteria = await db.get(
                `SELECT * FROM cafeterias WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!cafeteria) {
                return res.status(404).json({
                    success: false,
                    message: 'Refeitório não encontrado'
                });
            }
            
            res.json({
                success: true,
                data: cafeteria
            });
        } catch (error) {
            logger.error('Erro ao buscar refeitório:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar refeitório'
            });
        }
    }

    async create(req, res) {
        try {
            const tenantId = req.tenantId;
            const { name, location, capacity, schedule_id, active } = req.body;
            
            const result = await db.run(
                `INSERT INTO cafeterias (tenant_id, name, location, capacity, schedule_id, active, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
                [tenantId, name, location || null, capacity || null, schedule_id || null, active ? 1 : 0]
            );
            
            logger.info(`Refeitório criado: ${name} para tenant ${tenantId}`);
            
            res.status(201).json({
                success: true,
                data: {
                    id: result.id,
                    tenant_id: tenantId,
                    name,
                    location,
                    capacity,
                    schedule_id,
                    active: active ? 1 : 0
                }
            });

            // Log audit
            await auditService.logCreate(req, 'cafeteria', result.id, `Criação de cafeteria/refeitório: ${name}`, req.body);
        } catch (error) {
            logger.error('Erro ao criar refeitório:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao criar refeitório'
            });
        }
    }

    async update(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            const { name, location, capacity, schedule_id, active } = req.body;
            
            const existing = await db.get(
                `SELECT * FROM cafeterias WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Refeitório não encontrado'
                });
            }
            
            await db.run(
                `UPDATE cafeterias SET name = ?, location = ?, capacity = ?, schedule_id = ?, active = ?, updated_at = datetime('now')
                 WHERE id = ? AND tenant_id = ?`,
                [name, location, capacity, schedule_id, active ? 1 : 0, id, tenantId]
            );
            
            logger.info(`Refeitório atualizado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                data: { id, name, location, capacity, schedule_id, active: active ? 1 : 0 }
            });

            // Log audit
            const updated = { id, name, location, capacity, schedule_id, active: active ? 1 : 0 };
            await auditService.logUpdate(req, 'cafeteria', id, `Atualização de cafeteria/refeitório: ${name}`, existing, updated);
        } catch (error) {
            logger.error('Erro ao atualizar refeitório:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao atualizar refeitório'
            });
        }
    }

    async delete(req, res) {
        try {
            const { id } = req.params;
            const tenantId = req.tenantId;
            
            const existing = await db.get(
                `SELECT * FROM cafeterias WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    message: 'Refeitório não encontrado'
                });
            }
            
            await db.run(
                `DELETE FROM cafeterias WHERE id = ? AND tenant_id = ?`,
                [id, tenantId]
            );
            
            logger.info(`Refeitório deletado: ${id} para tenant ${tenantId}`);
            
            res.json({
                success: true,
                message: 'Refeitório deletado com sucesso'
            });

            // Log audit
            await auditService.logDelete(req, 'cafeteria', id, `Exclusão de cafeteria/refeitório: ${existing.name || id}`, existing);
        } catch (error) {
            logger.error('Erro ao deletar refeitório:', error);
            res.status(500).json({
                success: false,
                message: 'Erro ao deletar refeitório'
            });
        }
    }
}

export default new CafeteriaController();

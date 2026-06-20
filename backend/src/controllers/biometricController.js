// Controller for Biometric Template Enrollment
// This controller handles receiving biometric templates from equipment communicators

import { getTenantDatabase } from '../middleware/tenantManager.js';

class BiometricController {
    // Receive biometric template from communicator
    async receiveTemplate(req, res) {
        try {
            const { tenant_id, person_id } = req.params;
            const { 
                device_id, 
                identifier_id, 
                finger_type, 
                template_data,
                template_format,
                variance,
                uuid
            } = req.body;
            
            if (!tenant_id || !person_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id e person_id'
                });
            }
            
            if (!template_data) {
                return res.status(400).json({
                    success: false,
                    message: 'Template biométrico não fornecido'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Verify person exists
            const person = await db.get('SELECT id, name FROM persons WHERE id = ?', [person_id]);
            if (!person) {
                return res.status(404).json({
                    success: false,
                    message: 'Pessoa não encontrada'
                });
            }
            
            // Determine finger type if not provided
            const finalFingerType = finger_type || 'unknown';
            
            // Store the biometric template
            // template_data can be either base64 string or binary buffer
            let templateBuffer;
            if (typeof template_data === 'string') {
                // Base64 encoded
                templateBuffer = Buffer.from(template_data, 'base64');
            } else if (Buffer.isBuffer(template_data)) {
                templateBuffer = template_data;
            } else {
                // Try to convert from array
                templateBuffer = Buffer.from(template_data);
            }
            
            const result = await db.run(
                `INSERT INTO biometric_templates 
                 (tenant_id, person_id, finger_type, template_data, template_format, device_id, identifier_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenant_id, 
                    person_id, 
                    finalFingerType, 
                    templateBuffer, 
                    template_format || 'INNOVATRICS', 
                    device_id || null, 
                    identifier_id || null
                ]
            );
            
            console.log(`[Biometric] Template cadastrado para pessoa ${person_id} (${person.name}), dedo: ${finalFingerType}, tamanho: ${templateBuffer.length} bytes`);
            
            return res.json({
                success: true,
                message: 'Template biométrico cadastrado com sucesso',
                data: {
                    id: result.lastID,
                    person_id: person_id,
                    person_name: person.name,
                    finger_type: finalFingerType,
                    template_size: templateBuffer.length,
                    template_format: template_format || 'INNOVATRICS',
                    device_id: device_id || null
                }
            });
            
        } catch (error) {
            console.error('[Biometric] Erro ao receber template:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao processar template biométrico: ' + error.message
            });
        }
    }
    
    // Get all biometric templates for a person
    async getTemplates(req, res) {
        try {
            const { tenant_id, person_id } = req.params;
            
            if (!tenant_id || !person_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id e person_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            const templates = await db.all(
                `SELECT id, finger_type, template_format, device_id, identifier_id, created_at, is_active
                 FROM biometric_templates 
                 WHERE person_id = ? AND is_active = 1
                 ORDER BY created_at DESC`,
                [person_id]
            );
            
            return res.json({
                success: true,
                data: templates
            });
            
        } catch (error) {
            console.error('[Biometric] Erro ao buscar templates:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao buscar templates biométricos: ' + error.message
            });
        }
    }
    
    // Delete a biometric template
    async deleteTemplate(req, res) {
        try {
            const { tenant_id, template_id } = req.params;
            
            if (!tenant_id || !template_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id e template_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Soft delete - set is_active to 0
            const result = await db.run(
                `UPDATE biometric_templates SET is_active = 0 WHERE id = ?`,
                [template_id]
            );
            
            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Template biométrico não encontrado'
                });
            }
            
            return res.json({
                success: true,
                message: 'Template biométrico removido com sucesso'
            });
            
        } catch (error) {
            console.error('[Biometric] Erro ao excluir template:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao excluir template biométrico: ' + error.message
            });
        }
    }
    
    // Get biometric enrollment status for a person (for frontend polling)
    async getEnrollmentStatus(req, res) {
        try {
            const { tenant_id, person_id } = req.params;
            
            if (!tenant_id || !person_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id e person_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Get all active templates
            const templates = await db.all(
                `SELECT id, finger_type, created_at FROM biometric_templates 
                 WHERE person_id = ? AND is_active = 1`,
                [person_id]
            );
            
            // Check if there's a pending template_remote task
            const pendingTask = await db.get(
                `SELECT id, finger_type, created_at FROM access_tasks 
                 WHERE task_type = 'template_remote' AND person_id = ? AND resolved = 0
                 ORDER BY created_at DESC LIMIT 1`,
                [person_id]
            );
            
            return res.json({
                success: true,
                data: {
                    person_id: person_id,
                    has_templates: templates.length > 0,
                    templates_count: templates.length,
                    templates: templates.map(t => ({
                        id: t.id,
                        finger: t.finger_type,
                        created_at: t.created_at
                    })),
                    pending_task: pendingTask ? {
                        task_id: pendingTask.id,
                        finger_type: pendingTask.finger_type,
                        created_at: pendingTask.created_at
                    } : null
                }
            });
            
        } catch (error) {
            console.error('[Biometric] Erro ao verificar status:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao verificar status de cadastramento: ' + error.message
            });
        }
    }
    
    // Resolve the template_remote task after successful enrollment
    async resolveEnrollmentTask(req, res) {
        try {
            const { tenant_id, person_id } = req.params;
            
            if (!tenant_id || !person_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id e person_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Find and resolve the pending task
            const task = await db.get(
                `SELECT id FROM access_tasks 
                 WHERE task_type = 'template_remote' AND person_id = ? AND resolved = 0
                 ORDER BY created_at DESC LIMIT 1`,
                [person_id]
            );
            
            if (task) {
                await db.run(
                    `UPDATE access_tasks 
                     SET resolved = 1, resolved_at = datetime('now'), resolved_by = 'biometric_enrollment' 
                     WHERE id = ?`,
                    [task.id]
                );
                
                return res.json({
                    success: true,
                    message: 'Tarefa de cadastramento resolvida',
                    data: { task_id: task.id }
                });
            }
            
            return res.json({
                success: true,
                message: 'Nenhuma tarefa pendente encontrada'
            });
            
        } catch (error) {
            console.error('[Biometric] Erro ao resolver tarefa:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao resolver tarefa: ' + error.message
            });
        }
    }
    
    // Identify person by biometric template (matching)
    async identifyBiometric(req, res) {
        try {
            const { tenant_id } = req.params;
            const { 
                device_id, 
                template_data,
                template_format,
                equip_validator
            } = req.body;
            
            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    status: false,
                    message: 'Parâmetro obrigatório: tenant_id'
                });
            }
            
            if (!template_data) {
                return res.status(400).json({
                    success: false,
                    status: false,
                    message: 'Template biométrico não fornecido'
                });
            }
            
            // Convert template_data to buffer if it's base64
            let templateBuffer;
            if (typeof template_data === 'string') {
                templateBuffer = Buffer.from(template_data, 'base64');
            } else if (Buffer.isBuffer(template_data)) {
                templateBuffer = template_data;
            } else {
                templateBuffer = Buffer.from(template_data);
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Get all active biometric templates
            const templates = await db.all(
                `SELECT bt.id, bt.person_id, bt.finger_type, p.name as person_name
                 FROM biometric_templates bt
                 JOIN persons p ON bt.person_id = p.id
                 WHERE bt.is_active = 1`
            );
            
            if (templates.length === 0) {
                return res.json({
                    success: true,
                    identified: false,
                    status: false,
                    message: 'Nenhum template biométrico cadastrado',
                    data: {}
                });
            }
            
            console.log(`[Biometric] Identify called with template size: ${templateBuffer.length}`);
            console.log(`[Biometric] Total templates to compare: ${templates.length}`);
            
            // Placeholder: Implementar com SDK biométrico (Innovatrics, etc.)
            return res.json({
                success: true,
                identified: false,
                status: false,
                message: 'Identificação biométrica requer SDK específico (Innovatrics)',
                data: {
                    templates_count: templates.length,
                    note: 'IMPLEMENTAR: Integração com SDK biométrico para matching'
                }
            });
            
        } catch (error) {
            console.error('[Biometric] Erro na identificação:', error);
            return res.status(500).json({
                success: false,
                status: false,
                message: 'Erro ao identificar biometria: ' + error.message
            });
        }
    }
    
    // Identify and authorize access by biometric template
    async identifyAndAuthorize(req, res) {
        try {
            const { tenant_id } = req.params;
            const { 
                device_id, 
                template_data,
                template_format,
                equip_validator
            } = req.body;
            
            if (!tenant_id || !equip_validator) {
                return res.status(400).json({
                    success: false,
                    status: false,
                    message: 'Parâmetros obrigatórios: tenant_id e equip_validator'
                });
            }
            
            if (!template_data) {
                return res.status(400).json({
                    success: false,
                    status: false,
                    message: 'Template biométrico não fornecido'
                });
            }
            
            // Convert template_data to buffer
            let templateBuffer;
            if (typeof template_data === 'string') {
                templateBuffer = Buffer.from(template_data, 'base64');
            } else if (Buffer.isBuffer(template_data)) {
                templateBuffer = template_data;
            } else {
                templateBuffer = Buffer.from(template_data);
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Get all active biometric templates
            const templates = await db.all(
                `SELECT bt.id, bt.person_id, bt.finger_type, p.name as person_name
                 FROM biometric_templates bt
                 JOIN persons p ON bt.person_id = p.id
                 WHERE bt.is_active = 1`
            );
            
            if (templates.length === 0) {
                return res.json({
                    success: true,
                    identified: false,
                    status: false,
                    message: 'Nenhum template biométrico cadastrado',
                    data: {}
                });
            }
            
            console.log(`[Biometric] Identify & Authorize - template size: ${templateBuffer.length}, templates: ${templates.length}`);
            
            // Placeholder: Implementar com SDK biométrico para matching
            // Após identificar, chamar o serviço de autorização
            // const { processarAcesso } = await import('../services/autorizadorService.js');
            // const result = await processarAcesso(tenant_id, equip_validator, identifiedPersonId);
            
            return res.json({
                success: true,
                identified: false,
                status: false,
                message: 'Identificação biométrica requer SDK específico (Innovatrics)',
                data: {
                    templates_count: templates.length,
                    note: 'IMPLEMENTAR: Integração com SDK biométrico para matching, depois chamar autorização'
                }
            });
            
        } catch (error) {
            console.error('[Biometric] Erro na identificação e autorização:', error);
            return res.status(500).json({
                success: false,
                status: false,
                message: 'Erro ao processar biometria: ' + error.message
            });
        }
    }
}

export default new BiometricController();

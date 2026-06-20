import { getTenantDatabase } from '../middleware/tenantManager.js';
import photoService from '../services/photoService.js';
import logger from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

class FaceRemoteController {
    /**
     * Create a task for remote face capture
     * POST /api/face-remote/task/:tenant_id
     */
    createFaceTask = asyncHandler(async (req, res) => {
        const { tenant_id } = req.params;
        const { equip_validator, person_id, visitor_id, person_type = 'person' } = req.body;

        if (!tenant_id || !equip_validator) {
            return res.status(400).json({
                success: false,
                message: 'Tenant ID e Validador do Equipamento são obrigatórios'
            });
        }

        if (!person_id && !visitor_id && person_type !== 'visitor') {
          // No caso de visitante novo, permitimos sem ID
          // Mas para pessoa ou visitante existente, o ID é necessário
        }

        const db = await getTenantDatabase(tenant_id);

        // 1. Cancelar tarefas anteriores pendentes para o mesmo alvo
        await db.run(
            `UPDATE access_tasks 
             SET resolved = 1, status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'superseded'
             WHERE task_type = 'face_remote' 
             AND (person_id = ? OR visitor_id = ?) 
             AND resolved = 0`,
            [person_id || null, visitor_id || null]
        );

        // 2. Pré-cadastro de visitante se necessário
        let finalVisitorId = visitor_id;
        if (person_type === 'visitor' && !visitor_id) {
          const visitorName = req.body.visitor_name || 'Visitante Temporário';
          const visitorDoc = req.body.visitor_doc || 'TEMP_' + Date.now();
          
          try {
            // Tentar encontrar se já existe esse pré-cadastro para não duplicar
            const existing = await db.get('SELECT id FROM visitors WHERE document = ?', [visitorDoc]);
            if (existing) {
              finalVisitorId = existing.id;
            } else {
              const vResult = await db.run(
                `INSERT INTO visitors (name, document, status, created_at) VALUES (?, ?, 'pre-registered', CURRENT_TIMESTAMP)`,
                [visitorName, visitorDoc]
              );
              finalVisitorId = vResult.lastID;
              logger.info(`[FaceRemote] Pré-cadastro de visitante criado: ID ${finalVisitorId}`);
            }
          } catch (err) {
            logger.error('[FaceRemote] Erro ao realizar pré-cadastro:', err);
          }
        }

        // 3. Criar nova tarefa
        const result = await db.run(
            `INSERT INTO access_tasks (
                tenant_id, task_type, target_type, target_id, description, 
                equip_validator, status, created_at, person_id, visitor_id, person_type
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, ?, ?, ?)`,
            [
                tenant_id, 'face_remote', person_type, (person_id || finalVisitorId || '999'),
                `Captura remota de face para ${person_type} ID: ${person_id || finalVisitorId || '999'}${!visitor_id && finalVisitorId ? ' (PRÉ-CADASTRO)' : ''}`,
                equip_validator, person_id || null, finalVisitorId || null, person_type
            ]
        );

        return res.status(201).json({
            success: true,
            data: { task_id: result.lastID }
        });
    });

    /**
     * Get task status (polling)
     * GET /api/face-remote/status/:tenant_id/:task_id
     */
    getFaceTaskStatus = asyncHandler(async (req, res) => {
        const { tenant_id, task_id } = req.params;
        const db = await getTenantDatabase(tenant_id);

        const task = await db.get(
            `SELECT * FROM access_tasks WHERE id = ? AND task_type = 'face_remote'`,
            [task_id]
        );

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Tarefa não encontrada'
            });
        }

        const responseData = {
            task_id: task.id,
            status: task.status,
            resolved: task.resolved,
            error: task.error || null,
            has_photo: task.status === 'done',
            visitor_id: task.visitor_id,
            person_id: task.person_id
        };

        if (task.status === 'done' && task.resolved === 1) {
            // Buscar a URL da foto atualizada
            let photoUrlInDb = null;
            if (task.person_type === 'person' && task.person_id) {
                const person = await db.get('SELECT photo_url FROM persons WHERE id = ?', [task.person_id]);
                if (person && person.photo_url) photoUrlInDb = person.photo_url;
            } else if (task.person_type === 'visitor' && task.visitor_id) {
                const visitor = await db.get('SELECT id, photo_url FROM visitors WHERE id = ?', [task.visitor_id]);
                if (visitor && visitor.photo_url) photoUrlInDb = visitor.photo_url;
            }
            
            // Gerar URL assinada usando o serviço (limpa o caminho e adiciona token)
            if (photoUrlInDb) {
                responseData.photo_url = photoService.generateSignedUrl(photoUrlInDb, task.person_type, '1h');
            }
        }

        // Se ainda não temos photoUrl do registro, tenta pegar do result_data
        if (!responseData.photo_url && task.result_data) {
            responseData.photo_url = task.result_data;
        }

        return res.json({
            success: true,
            data: responseData
        });
    });

    /**
     * Receive captured photo from communicator
     * POST /api/face-remote/receive/:tenant_id/:task_id
     */
    receiveFacePhoto = asyncHandler(async (req, res) => {
        const { tenant_id, task_id } = req.params;
        const { photo_base64 } = req.body;

        if (!photo_base64) {
            return res.status(400).json({
                success: false,
                message: 'Foto base64 não fornecida'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        const task = await db.get(
            `SELECT * FROM access_tasks WHERE id = ? AND task_type = 'face_remote' AND resolved = 0`,
            [task_id]
        );

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Tarefa pendente não encontrada'
            });
        }

        try {
            // Processar e salvar a foto usando o photoService (ele cuida de redimensionar e criptografar)
            const photoResult = await photoService.processBase64Photo(
                photo_base64, 
                task.person_type, 
                null, 
                tenant_id
            );

            // Atualizar o registro da pessoa ou visitante com o caminho completo da foto
            if (task.person_type === 'person' && task.person_id) {
                await db.run('UPDATE persons SET photo_url = ? WHERE id = ?', [photoResult.url, task.person_id]);
            } else if (task.person_type === 'visitor' && task.visitor_id) {
                await db.run('UPDATE visitors SET photo_url = ? WHERE id = ?', [photoResult.url, task.visitor_id]);
            }

            // Marcar tarefa como resolvida
            await db.run(
                `UPDATE access_tasks 
                 SET resolved = 1, status = 'done', result_data = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = 'communicator'
                 WHERE id = ?`,
                [photoResult.url, task_id]
            );

            logger.info(`[FaceRemote] Foto recebida para tarefa ${task_id} (Tenant: ${tenant_id})`);

            return res.json({
                success: true,
                message: 'Foto recebida e processada com sucesso',
                data: { photo_url: photoResult.url }
            });

        } catch (error) {
            console.error('[FaceRemote] Erro ao processar foto recebida:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao processar imagem: ' + error.message
            });
        }
    });

    /**
     * Report error from communicator
     * POST /api/face-remote/error/:tenant_id/:task_id
     */
    reportFaceError = asyncHandler(async (req, res) => {
        const { tenant_id, task_id } = req.params;
        const { error_code, error_message } = req.body;

        const db = await getTenantDatabase(tenant_id);

        const task = await db.get(
            `SELECT * FROM access_tasks WHERE id = ? AND task_type = 'face_remote' AND resolved = 0`,
            [task_id]
        );

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Tarefa pendente não encontrada'
            });
        }

        const errorStr = (error_code || 'ERROR') + ': ' + (error_message || 'Erro desconhecido');

        await db.run(
            `UPDATE access_tasks 
             SET resolved = 1, status = 'error', error = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = 'communicator_error'
             WHERE id = ?`,
            [errorStr, task_id]
        );

        logger.warn(`[FaceRemote] Erro reportado pelo equipamento para tarefa ${task_id}: ${errorStr}`);

        return res.json({
            success: true,
            message: 'Erro registrado com sucesso'
        });
    });

    /**
     * Cancel task
     * DELETE /api/face-remote/task/:tenant_id/:task_id
     */
    cancelFaceTask = asyncHandler(async (req, res) => {
        const { tenant_id, task_id } = req.params;
        const db = await getTenantDatabase(tenant_id);

        const task = await db.get(
            `SELECT * FROM access_tasks WHERE id = ? AND task_type = 'face_remote'`,
            [task_id]
        );

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Tarefa não encontrada'
            });
        }

        // Se a tarefa já foi resolvida com sucesso, talvez queiramos reverter a foto?
        // O plano diz para deletar o arquivo físico se cancelado após sucesso.
        if ((task.status === 'done' && task.resolved === 1) || task.status === 'pending') {
            // Reverter ou limpar pré-cadastro
            if (task.person_type === 'person' && task.person_id && task.status === 'done') {
                const person = await db.get('SELECT photo_url FROM persons WHERE id = ?', [task.person_id]);
                if (person && person.photo_url) {
                    await photoService.deletePhoto(person.photo_url, 'person');
                    await db.run('UPDATE persons SET photo_url = NULL WHERE id = ?', [task.person_id]);
                }
            } else if (task.person_type === 'visitor' && task.visitor_id) {
                const visitor = await db.get('SELECT id, photo_url, status FROM visitors WHERE id = ?', [task.visitor_id]);
                if (visitor) {
                    // Se era pré-cadastro ou a descrição indica pré-cadastro, deleta o registro
                    const isPreReg = visitor.status === 'pre-registered' || (task.description && task.description.includes('PRÉ-CADASTRO'));
                    
                    if (isPreReg) {
                        if (visitor.photo_url) await photoService.deletePhoto(visitor.photo_url, 'visitor');
                        await db.run('DELETE FROM visitors WHERE id = ?', [task.visitor_id]);
                        logger.info(`[FaceRemote] Pré-cadastro deletado devido a cancelamento (${task.status}): ID ${task.visitor_id}`);
                    } else if (task.status === 'done' && visitor.photo_url) {
                        // Se não era pré-cadastro mas já tinha foto (tarefa concluída), apenas limpa a foto
                        await photoService.deletePhoto(visitor.photo_url, 'visitor');
                        await db.run('UPDATE visitors SET photo_url = NULL WHERE id = ?', [task.visitor_id]);
                    }
                }
            }
        }

        await db.run(
            `UPDATE access_tasks 
             SET resolved = 1, status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'user_cancelled'
             WHERE id = ?`,
            [task_id]
        );

        return res.json({
            success: true,
            message: 'Tarefa cancelada'
        });
    });
}

export default new FaceRemoteController();

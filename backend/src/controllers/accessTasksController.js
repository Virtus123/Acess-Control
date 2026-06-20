// Controller for Access Tasks - Emergency Mode and Release Access
// This controller handles tasks that equipment communicators will poll and execute

import { getTenantDatabase } from '../middleware/tenantManager.js';
import { enqueuePushCommands, enqueueForActiveDevices, isDevicePushEnabled, newBatchId } from '../services/pushOutbox.js';
import { toDeviceUserId } from '../services/deviceUserId.js';
import { getAuthorizedUsersForEquipment } from '../services/accessRuleResolver.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function loadPhotoBase64Soft(photoUrl) {
  if (!photoUrl) return null;
  try {
    const rel = photoUrl.replace(/^\//, '');
    for (const p of [
      join(process.cwd(), 'public', rel),
      join(process.cwd(), 'uploads', rel),
      join(process.cwd(), rel),
    ]) {
      try { return (await readFile(p)).toString('base64'); } catch {}
    }
  } catch {}
  return null;
}

// Traduz task de alto nível em comandos FCGI para o Push.
// Equipamento legado continua recebendo via access_tasks (polling do Comunicador).
// Equipamento com push_enabled=1 também recebe via push_outbox (entregue por long-poll).
//
// `modelo` é usado pra escolher action correta:
//   - modelo contém 'idblock' → { action: 'catra', parameters: 'allow=both' }
//   - resto                   → { action: 'sec_box', parameters: 'id=65793,reason=3' }
function translateTaskToPushCommands({ task_type, deviceId, modelo }) {
  const isCatra = /idblock/i.test(modelo || '');

  switch (task_type) {
    case 'emergencia':
      return [{
        deviceId,
        endpoint: 'set_configuration',
        origin: 'emergency:on',
        body: { general: { exception_mode: 'emergency' } },
      }];
    case 'desativar_emergencia':
      return [{
        deviceId,
        endpoint: 'set_configuration',
        origin: 'emergency:off',
        body: { general: { exception_mode: 'none' } },
      }];
    case 'liberar_acesso': {
      const action = isCatra
        ? { action: 'catra', parameters: 'allow=both' }
        : { action: 'sec_box', parameters: 'id=65793,reason=3' };
      return [{
        deviceId,
        endpoint: 'execute_actions',
        origin: 'grant_access',
        body: { actions: [action] },
      }];
    }
    case 'template_remote':
      // Biométrico remoto: fluxo do Comunicador é complexo (callback URL).
      // Manter no caminho legado por enquanto.
      return [];
    default:
      return [];
  }
}

class AccessTasksController {
    // Create a new task (called from frontend)
    async createTask(req, res) {
        try {
            const { tenant_id, equip_validator, task_type, person_id, finger_type } = req.body;
            
            if (!tenant_id || !equip_validator || !task_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, equip_validator, task_type'
                });
            }
            
            // Tipos válidos: 'emergencia' (ativar) e 'desativar_emergencia' são
            // SEMPRE inseridos como tasks novas. O comunicador faz polling, lê
            // a task, aplica a ação localmente no equipamento e marca resolved=1.
            // Isso é fundamental: sem nova task, o comunicador não fica sabendo
            // que precisa desativar o modo emergência.
            const validTaskTypes = ['emergencia', 'desativar_emergencia', 'liberar_acesso', 'template_remote'];
            if (!validTaskTypes.includes(task_type)) {
                return res.status(400).json({
                    success: false,
                    message: 'task_type inválido'
                });
            }

            const db = await getTenantDatabase(tenant_id);
            
            // Build the insert query based on task type
            let insertSql, insertParams;
            let callbackUrl = null;
            
            if (task_type === 'template_remote') {
                // For template_remote, we need person_id and finger_type
                if (!person_id) {
                    return res.status(400).json({
                        success: false,
                        message: 'Para template_remote, é necessário informar person_id'
                    });
                }
                
                // Generate callback URL for the communicator to send the template back
                callbackUrl = `/api/comunicador/biometric/response/${person_id}`;
                
                insertSql = `INSERT INTO access_tasks (tenant_id, equip_validator, task_type, status, resolved, person_id, finger_type, callback_url) 
                             VALUES (?, ?, ?, 1, 0, ?, ?, ?)`;
                insertParams = [tenant_id, equip_validator, task_type, person_id, finger_type || 'unknown', callbackUrl];
            } else {
                insertSql = `INSERT INTO access_tasks (tenant_id, equip_validator, task_type, status, resolved) 
                             VALUES (?, ?, ?, 1, 0)`;
                insertParams = [tenant_id, equip_validator, task_type];
            }
            
            // Create new task
            const result = await db.run(insertSql, insertParams);

            // Replica no push_outbox se o equipamento alvo estiver em modo push.
            // Best-effort — task em access_tasks já existe para o Comunicador legado.
            // sourceTaskId atrela o comando do Push à task — quando o equipamento
            // confirma execução, o markCompleted do Push fecha esta access_tasks.
            try {
                if (await isDevicePushEnabled(db, equip_validator)) {
                    // Busca modelo pra escolher action correto (catra vs sec_box)
                    const equipRow = await db.get(
                        'SELECT modelo FROM equipments WHERE validador = ? LIMIT 1',
                        [equip_validator]
                    );
                    const cmds = translateTaskToPushCommands({
                        task_type,
                        deviceId: equip_validator,
                        modelo: equipRow?.modelo,
                    });
                    if (cmds.length > 0) {
                        for (const c of cmds) c.sourceTaskId = result.lastID;
                        await enqueuePushCommands(db, cmds);
                    }
                }
            } catch (pushErr) {
                console.error('[push enqueue task]', pushErr.message);
            }

            let message;
            let mode = 'created';
            switch(task_type) {
                case 'emergencia':
                    message = 'Modo Emergência ativado';
                    mode = 'activated';
                    break;
                case 'desativar_emergencia':
                    message = 'Modo Emergência desativado';
                    mode = 'deactivated';
                    break;
                case 'liberar_acesso':
                    message = 'Acesso liberado';
                    break;
                case 'template_remote':
                    message = 'Cadastramento biométrico iniciado';
                    break;
                default:
                    message = 'Tarefa criada';
            }

            return res.json({
                success: true,
                message: message,
                data: {
                    id: result.lastID,
                    task_type: task_type,
                    status: 1,
                    person_id: person_id || null,
                    finger_type: finger_type || null,
                    callback_url: task_type === 'template_remote' ? callbackUrl : null,
                    mode
                }
            });
            
        } catch (error) {
            console.error('Error creating access task:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao criar tarefa: ' + error.message
            });
        }
    }
    
    // Get active tasks for equipment (called by communicator via polling)
    async getTasks(req, res) {
        try {
            const { tenant_id, equip_validator } = req.query;
            
            if (!tenant_id || !equip_validator) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Tasks pendentes (resolved=0) para este equipamento.
            // emergencia/desativar_emergencia são one-shot: comunicador lê,
            // aplica e marca como resolved. Estado persistido via timestamp
            // em getEmergencyStatus, não pela presença/ausência de task.
            const tasks = await db.all(
                `SELECT id, tenant_id, equip_validator, task_type, status, resolved, created_at, person_id, finger_type, callback_url, target_type, target_id, description, payload
                 FROM access_tasks
                 WHERE resolved = 0
                   AND (
                     equip_validator = ?
                     OR equip_validator = 'all'
                     OR equip_validator IS NULL
                     OR task_type IN ('delete_visitor', 'delete_person')
                   )
                 ORDER BY created_at ASC`,
                [equip_validator]
            );
            
            return res.json({
                success: true,
                data: tasks
            });
            
        } catch (error) {
            console.error('Error getting tasks:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao buscar tarefas: ' + error.message
            });
        }
    }
    
    // Mark task as resolved (called by communicator after executing)
    async resolveTask(req, res) {
        try {
            const { tenant_id, task_id, resolved_by, template_data, finger_type, device_id } = req.body;
            
            if (!tenant_id || !task_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, task_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Check if task exists and is not already resolved
            const task = await db.get(
                `SELECT id, task_type, resolved, person_id FROM access_tasks WHERE id = ?`,
                [task_id]
            );
            
            if (!task) {
                return res.status(404).json({
                    success: false,
                    message: 'Tarefa não encontrada'
                });
            }
            
            if (task.resolved === 1) {
                return res.json({
                    success: true,
                    message: 'Tarefa já resolvida',
                    data: { id: task_id, resolved: true }
                });
            }
            
            // Resolve task
            await db.run(
                `UPDATE access_tasks 
                 SET resolved = 1, resolved_at = datetime('now'), resolved_by = ? 
                 WHERE id = ?`,
                [resolved_by || 'communicator', task_id]
            );
            
            // If this is a template_remote task and we have template data, save it
            if (task.task_type === 'template_remote' && template_data && task.person_id) {
                try {
                    // Convert template_data to buffer if it's base64
                    let templateBuffer;
                    if (typeof template_data === 'string') {
                        templateBuffer = Buffer.from(template_data, 'base64');
                    } else if (Buffer.isBuffer(template_data)) {
                        templateBuffer = template_data;
                    } else {
                        templateBuffer = Buffer.from(template_data);
                    }
                    
                    await db.run(
                        `INSERT INTO biometric_templates 
                         (tenant_id, person_id, finger_type, template_data, template_format, device_id) 
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            tenant_id,
                            task.person_id,
                            finger_type || 'unknown',
                            templateBuffer,
                            'INNOVATRICS',
                            device_id || null
                        ]
                    );
                    
                    console.log(`[AccessTasks] Template biométrico salvo para pessoa ${task.person_id}, tamanho: ${templateBuffer.length} bytes`);
                } catch (templateError) {
                    console.error('[AccessTasks] Erro ao salvar template biométrico:', templateError);
                }
            }
            
            // IMPORTANTE: emergência é STATE, não one-shot.
            // Antes, ao resolver a task de emergência, o status ia pra 0 e o
            // botão do front (que olha status=1) parava de piscar — dando a
            // impressão que a emergência havia sido desativada sozinha. Agora
            // o status só muda via 'desativar_emergencia' explícito.
            return res.json({
                success: true,
                message: 'Tarefa resolvida',
                data: { id: task_id, resolved: true }
            });
            
        } catch (error) {
            console.error('Error resolving task:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao resolver tarefa: ' + error.message
            });
        }
    }
    
    // Clear all tasks for a tenant (resolve all pending tasks)
    async clearQueue(req, res) {
        try {
            const { tenant_id, task_id } = req.body;
            
            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetro obrigatório: tenant_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            let result;
            
            if (task_id) {
                // Clear specific task
                const task = await db.get(
                    `SELECT id, task_type FROM access_tasks WHERE id = ?`,
                    [task_id]
                );
                
                if (!task) {
                    return res.status(404).json({
                        success: false,
                        message: 'Tarefa não encontrada'
                    });
                }
                
                // Set resolved = 1
                await db.run(
                    `UPDATE access_tasks 
                     SET resolved = 1, resolved_at = datetime('now'), resolved_by = 'api' 
                     WHERE id = ?`,
                    [task_id]
                );
                
                // For emergency tasks, also deactivate
                if (task.task_type === 'emergencia') {
                    await db.run(
                        `UPDATE access_tasks SET status = 0 WHERE id = ?`,
                        [task_id]
                    );
                }
                
                result = { cleared: 1, task_id: task_id };
            } else {
                // Clear all pending tasks for this tenant
                const info = await db.run(
                    `UPDATE access_tasks 
                     SET resolved = 1, resolved_at = datetime('now'), resolved_by = 'api' 
                     WHERE resolved = 0`
                );
                
                // Deactivate all emergency tasks
                await db.run(
                    `UPDATE access_tasks SET status = 0 WHERE task_type = 'emergencia' AND resolved = 1`
                );
                
                result = { cleared: info.changes };
            }
            
            return res.json({
                success: true,
                message: 'Fila de tarefas limpa',
                data: result
            });
            
        } catch (error) {
            console.error('Error clearing queue:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao limpar fila: ' + error.message
            });
        }
    }
    
    // Get emergency mode status
    async getEmergencyStatus(req, res) {
        try {
            const { tenant_id } = req.query;
            
            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // Estado da emergência via timestamp.
            // IMPORTANTE: filtra status=1 para descartar tasks legadas que o
            // código antigo marcava com status=0 ao "desativar" via UPDATE
            // (sem criar task de desativação). Sem esse filtro, qualquer
            // tenant com toggle antigo aparecia como emergência ativa.
            const lastActivate = await db.get(
                `SELECT id, created_at FROM access_tasks
                 WHERE task_type = 'emergencia' AND status = 1
                 ORDER BY created_at DESC LIMIT 1`
            );
            const lastDeactivate = await db.get(
                `SELECT created_at FROM access_tasks
                 WHERE task_type = 'desativar_emergencia' AND status = 1
                 ORDER BY created_at DESC LIMIT 1`
            );

            const isActive = !!(
                lastActivate &&
                (!lastDeactivate || lastActivate.created_at > lastDeactivate.created_at)
            );

            return res.json({
                success: true,
                data: {
                    active: isActive,
                    task_id: isActive ? lastActivate.id : null,
                    activated_at: isActive ? lastActivate.created_at : null
                }
            });
            
        } catch (error) {
            console.error('Error getting emergency status:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao verificar status de emergência: ' + error.message
            });
        }
    }
    
    // List all tasks (for admin/debugging and frontend queue)
    async listTasks(req, res) {
        try {
            const { tenant_id, limit = 100, page = 1, status, search } = req.query;
            
            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            let query = `SELECT * FROM access_tasks WHERE 1=1`;
            const params = [];
            
            if (status === 'pending') {
                query += ` AND resolved = 0`;
            } else if (status === 'resolved') {
                query += ` AND resolved = 1`;
            }
            
            if (search) {
                query += ` AND (equip_validator LIKE ? OR task_type LIKE ? OR target_type LIKE ? OR target_id LIKE ? OR description LIKE ?)`;
                const searchParam = `%${search}%`;
                params.push(searchParam, searchParam, searchParam, searchParam, searchParam);
            }
            
            // Get total count for pagination
            const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
            const { total } = await db.get(countQuery, params);
            
            query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            params.push(parseInt(limit), offset);
            
            const tasks = await db.all(query, params);
            
            return res.json({
                success: true,
                data: tasks,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(total / parseInt(limit))
                }
            });
            
        } catch (error) {
            console.error('Error listing tasks:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao listar tarefas: ' + error.message
            });
        }
    }
    
    // Sync all persons to equipment (now using sequential queue)
    async syncAllPersons(req, res) {
        try {
            const { tenant_id, equip_validator } = req.body;
            
            if (!tenant_id || !equip_validator) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            // 1. Identificar quais equipamentos devem ser sincronizados
            //    Inclui equip.id (precisa pro accessRuleResolver, que filtra por id).
            let equipments = [];
            if (equip_validator === 'all') {
                equipments = await db.all(
                    "SELECT id, validador FROM equipments WHERE active = 1 AND status = 'active'"
                );
            } else {
                const equip = await db.get(
                    "SELECT id, validador FROM equipments WHERE validador = ? AND active = 1",
                    [equip_validator]
                );
                if (equip) {
                    equipments = [equip];
                }
            }

            if (equipments.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Nenhum equipamento ativo encontrado para sincronização'
                });
            }

            // 2. Adicionar cada equipamento na fila de sincronização.
            //    Para equip push-enabled, status já entra como 'syncing' e capturamos
            //    o lastID — vamos usá-lo como source_sync_id em cada comando push,
            //    pra bridge no Push fechar a queue assim que o último item terminar.
            let queuedCount = 0;
            let alreadyQueuedCount = 0;
            // validador → { syncId, equipId } (só push). equipId é necessário pro resolver.
            const pushContext = new Map();

            for (const equip of equipments) {
                const existing = await db.get(
                    "SELECT id, status FROM equip_sync_queue WHERE equip_validator = ? AND status IN ('pending', 'syncing')",
                    [equip.validador]
                );

                if (existing) {
                    alreadyQueuedCount++;
                    if (await isDevicePushEnabled(db, equip.validador)) {
                        pushContext.set(equip.validador, { syncId: existing.id, equipId: equip.id });
                    }
                    continue;
                }

                const pushEnabled = await isDevicePushEnabled(db, equip.validador);
                const initialStatus = pushEnabled ? 'syncing' : 'pending';
                const insert = await db.run(
                    `INSERT INTO equip_sync_queue (tenant_id, equip_validator, status, started_at)
                     VALUES (?, ?, ?, ${pushEnabled ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
                    [tenant_id, equip.validador, initialStatus]
                );
                queuedCount++;
                if (pushEnabled) {
                    pushContext.set(equip.validador, { syncId: insert.lastID, equipId: equip.id });
                }
            }

            // PUSH MODE: para cada equip push-enabled, aplica regras de acesso:
            //  1. destroy_objects users (wipe completo — equipamento parte do zero)
            //  2. enfileira create_or_modify_objects + user_groups + user_set_image
            //     APENAS para pessoas/visitantes que o accessRuleResolver autorizar.
            //
            // OR-entre-regras: o resolver já faz UNION de todas as regras ativas
            // que mencionam o equipId. Sem regra cobrindo → equip fica vazio.
            let pushEnqueued = 0;
            const perDeviceStats = []; // pra log/resposta
            try {
                for (const [deviceId, ctx] of pushContext.entries()) {
                    const { syncId: sourceSyncId, equipId } = ctx;

                    // Resolve quem PODE estar nesse equipamento (com bypassCache pra refletir
                    // estado pós-mutação de regras/grupos)
                    const { personIds, visitorIds } = await getAuthorizedUsersForEquipment(
                        tenant_id, equipId, { bypassCache: true }
                    );

                    // Carrega dados completos só dos autorizados
                    let persons = [];
                    let visitors = [];
                    if (personIds.size > 0) {
                        const ph = Array.from(personIds).map(() => '?').join(',');
                        persons = await db.all(
                            `SELECT id, name, registration_number, photo_url FROM persons
                             WHERE status = 'active' AND name IS NOT NULL AND id IN (${ph})`,
                            Array.from(personIds)
                        );
                    }
                    if (visitorIds.size > 0) {
                        const ph = Array.from(visitorIds).map(() => '?').join(',');
                        visitors = await db.all(
                            `SELECT id, name, registration_number, photo_url FROM visitors
                             WHERE status IN ('on_premises','pre-registered') AND name IS NOT NULL AND id IN (${ph})`,
                            Array.from(visitorIds)
                        );
                    }
                    const subjects = [
                        ...persons.map(p => ({ ...p, kind: 'person' })),
                        ...visitors.map(v => ({ ...v, kind: 'visitor' })),
                    ];

                    // 1) Wipe — destroy_objects sem where = remove todos os users.
                    //    Idempotente: equip recém-formatado também aceita ok.
                    await enqueuePushCommands(db, [{
                        deviceId,
                        endpoint: 'destroy_objects',
                        origin: 'sync:wipe',
                        sourceSyncId,
                        body: { object: 'users' },
                    }]);
                    pushEnqueued++;

                    // 2) Recreate apenas os autorizados.
                    //    BATCH 1: user + grupo (rápido, sempre passa).
                    //    BATCH 2: só foto, isolada. Se foto falhar (ex: imagem <160px),
                    //    user fica cadastrado mesmo assim.
                    for (const s of subjects) {
                        const origin = `sync:${s.kind}:${s.id}`;
                        const equipUserId = toDeviceUserId(s.kind, s.id, s.registration_number);

                        const registerBatchId = newBatchId();
                        const registerCmds = [
                            {
                                deviceId, batchId: registerBatchId, batchOrder: 0, origin, sourceSyncId,
                                endpoint: 'create_or_modify_objects',
                                body: {
                                    object: 'users',
                                    values: [{
                                        id: equipUserId,
                                        registration: s.registration_number
                                          ? String(s.registration_number)
                                          : `${tenant_id}_${s.kind[0]}${s.id}`,
                                        name: s.name,
                                    }],
                                },
                            },
                            {
                                deviceId, batchId: registerBatchId, batchOrder: 1, origin, sourceSyncId,
                                endpoint: 'create_or_modify_objects',
                                body: {
                                    object: 'user_groups',
                                    values: [{ user_id: equipUserId, group_id: 1 }],
                                },
                            },
                        ];
                        await enqueuePushCommands(db, registerCmds);
                        pushEnqueued += registerCmds.length;

                        const photo = await loadPhotoBase64Soft(s.photo_url);
                        if (photo) {
                            await enqueuePushCommands(db, [{
                                deviceId, origin: `${origin}:photo`, sourceSyncId,
                                endpoint: 'user_set_image',
                                queryString: `user_id=${equipUserId}&timestamp=${Math.floor(Date.now()/1000)}&match=0`,
                                body: photo,
                                contentType: 'application/octet-stream',
                            }]);
                            pushEnqueued++;
                        }
                    }

                    perDeviceStats.push({
                        deviceId, persons: persons.length, visitors: visitors.length,
                        totalAuthorized: subjects.length,
                    });
                }
                if (perDeviceStats.length > 0) {
                    console.log('[sync push] resolver-driven:', JSON.stringify(perDeviceStats));
                }
            } catch (pushErr) {
                console.error('[sync push] erro:', pushErr.message);
            }
            
            let message = '';
            if (queuedCount > 0) {
                message = `${queuedCount} equipamento(s) adicionado(s) à fila de sincronização.`;
                if (alreadyQueuedCount > 0) {
                    message += ` (${alreadyQueuedCount} já estavam na fila).`;
                }
            } else if (alreadyQueuedCount > 0) {
                message = `O(s) equipamento(s) já estão em processo de sincronização (${alreadyQueuedCount} ativo/pendente).`;
            } else {
                message = 'Nenhum equipamento foi adicionado à fila.';
            }

            return res.json({
                success: true,
                message: message,
                queued: queuedCount,
                already_queued: alreadyQueuedCount,
                total_requested: equipments.length
            });
            
        } catch (error) {
            console.error('Error syncing all persons:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao iniciar sincronização: ' + error.message
            });
        }
    }

    // POST /api/comunicador/tasks/audit-result
    // Recebe a lista de usuários encontrada pelo comunicador num equipamento,
    // compara com as pessoas ativas esperadas (por regras de acesso) e:
    //   - visitantes encontrados → marca como exited + cria delete_visitor
    //   - pessoas não esperadas → cria delete_person para o equipamento
    async auditResult(req, res) {
        try {
            const { tenant_id, equip_validator, users } = req.body;

            if (!tenant_id || !equip_validator || !Array.isArray(users)) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, equip_validator, users[]'
                });
            }

            const db = await getTenantDatabase(tenant_id);

            // ── 1. Montar conjunto de IDs esperados no equipamento ────────────
            // Segue a mesma lógica de access_rules do getDiffSyncData,
            // mas retorna só IDs de PESSOAS (não visitantes — esses são tratados separado).
            const equipment = await db.get(
                'SELECT id FROM equipments WHERE validador = ? AND active = 1 LIMIT 1',
                [equip_validator]
            );

            let expectedEquipIds = null; // null = todos os ativos

            if (equipment) {
                const rules = await db.all(
                    `SELECT access_type, persons, companies, groups
                     FROM access_rules
                     WHERE active = 1
                       AND (access_target = 'persons' OR access_target IS NULL)
                       AND EXISTS (
                           SELECT 1 FROM json_each(equipments)
                           WHERE CAST(value AS INTEGER) = ?
                       )`,
                    [equipment.id]
                );

                if (rules.length > 0) {
                    const hasAllRule = rules.some(
                        r => r.access_type === 'todos' || r.access_type === 'pessoas-geral'
                    );

                    if (!hasAllRule) {
                        const idSet = new Set();

                        for (const rule of rules) {
                            if (rule.access_type === 'pessoas-especificas') {
                                JSON.parse(rule.persons || '[]').forEach(id => idSet.add(Number(id)));

                            } else if (rule.access_type === 'grupos') {
                                const groupIds = JSON.parse(rule.groups || '[]');
                                if (groupIds.length > 0) {
                                    const ph = groupIds.map(() => '?').join(',');
                                    const rows = await db.all(
                                        `SELECT DISTINCT p.id FROM persons p
                                         LEFT JOIN person_groups pg ON p.id = pg.person_id
                                         WHERE p.status = 'active'
                                           AND (p.group_id IN (${ph}) OR pg.group_id IN (${ph}))`,
                                        [...groupIds, ...groupIds]
                                    );
                                    rows.forEach(r => idSet.add(r.id));
                                }

                            } else if (rule.access_type === 'empresas') {
                                const companyIds = JSON.parse(rule.companies || '[]');
                                if (companyIds.length > 0) {
                                    const ph = companyIds.map(() => '?').join(',');
                                    const rows = await db.all(
                                        `SELECT id FROM persons WHERE status = 'active' AND company_id IN (${ph})`,
                                        companyIds
                                    );
                                    rows.forEach(r => idSet.add(r.id));
                                }
                            }
                        }

                        expectedEquipIds = idSet; // Set de backend person.id
                    }
                }
            }

            // Converter para conjunto de IDs de equipamento (toPersonId logic):
            // Se person.registration_number é numérico → equipID = registration_number
            // Caso contrário → equipID = person.id
            let expectedSet = new Set(); // IDs no formato do equipamento

            if (expectedEquipIds === null) {
                const allPersons = await db.all(
                    'SELECT id, registration_number FROM persons WHERE status = \'active\''
                );
                for (const p of allPersons) {
                    const num = Number(p.registration_number);
                    expectedSet.add(!isNaN(num) && p.registration_number ? num : p.id);
                }
            } else if (expectedEquipIds.size > 0) {
                const ph = [...expectedEquipIds].map(() => '?').join(',');
                const filtered = await db.all(
                    `SELECT id, registration_number FROM persons WHERE status = 'active' AND id IN (${ph})`,
                    [...expectedEquipIds]
                );
                for (const p of filtered) {
                    const num = Number(p.registration_number);
                    expectedSet.add(!isNaN(num) && p.registration_number ? num : p.id);
                }
            }
            // expectedEquipIds.size === 0 → nenhuma pessoa esperada, expectedSet permanece vazio

            // ── 2. Processar cada usuário encontrado no equipamento ───────────
            const prefix = tenant_id + '_';
            let visitorsExited = 0;
            let deletedPersons = 0;

            for (const user of users) {
                // Extrair personId do campo registration
                const reg = String(user.registration || '');
                let personId = null;
                if (reg.startsWith(prefix)) {
                    const raw = reg.substring(prefix.length);
                    const num = Number(raw);
                    if (!isNaN(num)) personId = num;
                }
                if (personId === null) {
                    const num = Number(user.id);
                    if (!isNaN(num)) personId = num;
                }
                if (personId === null) continue;

                // Verificar se é visitante
                let visitor = await db.get(
                    'SELECT id, name, status FROM visitors WHERE CAST(registration_number AS INTEGER) = ? LIMIT 1',
                    [personId]
                );
                if (!visitor && personId > 100000) {
                    visitor = await db.get(
                        'SELECT id, name, status FROM visitors WHERE id = ? LIMIT 1',
                        [personId - 100000]
                    );
                }
                if (!visitor) {
                    visitor = await db.get(
                        'SELECT id, name, status FROM visitors WHERE id = ? LIMIT 1',
                        [personId]
                    );
                }

                if (visitor) {
                    // Visitante → inativar no sistema e criar tarefa de exclusão
                    if (visitor.status !== 'exited') {
                        await db.run(
                            'UPDATE visitors SET status = ?, exit_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            ['exited', visitor.id]
                        );
                    }

                    // Criar delete_visitor apenas se não houver uma pendente
                    const existingTask = await db.get(
                        'SELECT id FROM access_tasks WHERE task_type = ? AND target_id = ? AND resolved = 0 LIMIT 1',
                        ['delete_visitor', String(personId)]
                    );
                    if (!existingTask) {
                        await db.run(
                            `INSERT INTO access_tasks
                             (tenant_id, task_type, target_type, target_id, status, resolved, created_at, description, equip_validator)
                             VALUES (?, 'delete_visitor', 'visitor', ?, 'pending', 0, datetime('now'), ?, 'all')`,
                            [tenant_id, String(personId),
                             `Auditoria noturna — visitante saiu: ${user.name || visitor.name || personId}`]
                        );
                    }
                    visitorsExited++;

                } else if (!expectedSet.has(personId)) {
                    // Pessoa não esperada neste equipamento → delete específico
                    const existingTask = await db.get(
                        `SELECT id FROM access_tasks
                         WHERE task_type = 'delete_person' AND target_id = ? AND equip_validator = ? AND resolved = 0 LIMIT 1`,
                        [String(personId), equip_validator]
                    );
                    if (!existingTask) {
                        await db.run(
                            `INSERT INTO access_tasks
                             (tenant_id, task_type, target_type, target_id, status, resolved, created_at, description, equip_validator)
                             VALUES (?, 'delete_person', 'person', ?, 'pending', 0, datetime('now'), ?, ?)`,
                            [tenant_id, String(personId),
                             `Auditoria noturna — pessoa sem permissão: ${user.name || personId}`,
                             equip_validator]
                        );
                    }
                    deletedPersons++;
                }
            }

            // Persistir resultado na task de auditoria para monitoramento na UI
            const auditTask = await db.get(
                "SELECT id FROM access_tasks WHERE task_type = 'audit_equipment' AND equip_validator = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1",
                [equip_validator, tenant_id]
            );
            if (auditTask) {
                const payload = JSON.stringify({
                    visitors_exited: visitorsExited,
                    deleted: deletedPersons,
                    total: users.length,
                    finished_at: new Date().toISOString()
                });
                await db.run(
                    "UPDATE access_tasks SET payload = ? WHERE id = ?",
                    [payload, auditTask.id]
                );
            }

            return res.json({
                success: true,
                visitors_exited: visitorsExited,
                deleted: deletedPersons,
                total_on_equipment: users.length
            });

        } catch (error) {
            console.error('Error in auditResult:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao processar resultado de auditoria: ' + error.message
            });
        }
    }
    // Lista equipamentos ativos para seleção na UI
    async listAuditableEquipments(req, res) {
        try {
            const db = req.db;
            const equipments = await db.all(
                "SELECT id, validador, name, modelo FROM equipments WHERE active = 1 AND status = 'active' AND validador IS NOT NULL ORDER BY name ASC"
            );
            return res.json({ success: true, data: equipments });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    // Disparo manual de auditoria — retorna IDs das tasks criadas para monitoramento
    async triggerAudit(req, res) {
        try {
            const tenantId = req.tenantId;
            const db = req.db;
            const { equip_validators } = req.body;

            let equipments;
            if (equip_validators && equip_validators.length > 0) {
                const ph = equip_validators.map(() => '?').join(',');
                equipments = await db.all(
                    `SELECT id, validador, name FROM equipments WHERE active = 1 AND status = 'active' AND validador IN (${ph})`,
                    equip_validators
                );
            } else {
                equipments = await db.all(
                    "SELECT id, validador, name FROM equipments WHERE active = 1 AND status = 'active' AND validador IS NOT NULL"
                );
            }

            if (!equipments.length) {
                return res.json({ success: true, created: 0, tasks: [], message: 'Nenhum equipamento encontrado' });
            }

            const tasks = [];
            for (const equip of equipments) {
                await db.run(
                    "UPDATE access_tasks SET resolved = 1, status = 'cancelled' WHERE task_type = 'audit_equipment' AND equip_validator = ? AND resolved = 0",
                    [equip.validador]
                );
                const result = await db.run(
                    `INSERT INTO access_tasks (tenant_id, task_type, equip_validator, status, resolved, created_at, description)
                     VALUES (?, 'audit_equipment', ?, 'pending', 0, datetime('now'), ?)`,
                    [tenantId, equip.validador, `Auditoria manual: ${equip.name}`]
                );
                tasks.push({ id: result.lastID, equip_validator: equip.validador, equip_name: equip.name, status: 'pending' });
            }

            return res.json({ success: true, created: tasks.length, tasks });
        } catch (error) {
            console.error('[triggerAudit] Erro:', error);
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    // Status em tempo real das tasks de auditoria
    async auditTaskStatus(req, res) {
        try {
            const db = req.db;
            const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
            if (!ids.length) return res.json({ success: true, data: [] });

            const ph = ids.map(() => '?').join(',');
            const tasks = await db.all(
                `SELECT id, equip_validator, status, resolved, description, payload, resolved_at
                 FROM access_tasks WHERE id IN (${ph})`,
                ids
            );

            const data = tasks.map(t => {
                let result = null;
                try { if (t.payload) result = JSON.parse(t.payload); } catch {}
                return {
                    id: t.id,
                    equip_validator: t.equip_validator,
                    equip_name: (t.description || '').replace('Auditoria manual: ', ''),
                    resolved: t.resolved === 1,
                    cancelled: t.status === 'cancelled',
                    resolved_at: t.resolved_at,
                    result
                };
            });

            return res.json({ success: true, data });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    }

    // Cancelar tasks de auditoria pendentes
    async cancelAudit(req, res) {
        try {
            const db = req.db;
            const { ids } = req.body; // array de task IDs
            if (!ids || !ids.length) return res.json({ success: true, cancelled: 0 });

            const ph = ids.map(() => '?').join(',');
            const result = await db.run(
                `UPDATE access_tasks SET resolved = 1, status = 'cancelled', resolved_at = datetime('now')
                 WHERE id IN (${ph}) AND resolved = 0`,
                ids
            );
            return res.json({ success: true, cancelled: result.changes });
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    }
}

export default new AccessTasksController();

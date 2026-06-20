import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantDatabase } from '../middleware/tenantManager.js';

class SyncController {
    // GET /api/comunicador/sync/check?tenant_id=...&equip_validator=...
    // Verifica se é a vez do equipamento sincronizar
    checkSyncTurn = asyncHandler(async (req, res) => {
        const { tenant_id, equip_validator } = req.query;

        if (!tenant_id || !equip_validator) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        // Recuperar jobs de sincronização travados (sem conclusão em 10 minutos)
        await db.run(
            `UPDATE equip_sync_queue
             SET status = 'pending', started_at = NULL
             WHERE status = 'syncing'
               AND started_at <= datetime('now', '-10 minutes')`
        );

        // 1. Verificar se este equipamento já tem um job 'syncing'
        const myActiveJob = await db.get(
            `SELECT id, status FROM equip_sync_queue 
             WHERE equip_validator = ? AND status = 'syncing' 
             LIMIT 1`,
            [equip_validator]
        );

        if (myActiveJob) {
            return res.json({
                success: true,
                is_my_turn: true,
                status: 'syncing',
                message: 'Você já está sincronizando'
            });
        }

        // 2. Verificar se existe ALGUM equipamento 'syncing' no tenant
        const anySyncing = await db.get(
            `SELECT id, equip_validator FROM equip_sync_queue 
             WHERE status = 'syncing' 
             LIMIT 1`
        );

        if (anySyncing) {
            return res.json({
                success: true,
                is_my_turn: false,
                status: 'waiting',
                message: `Aguardando equipamento ${anySyncing.equip_validator} finalizar`
            });
        }

        // 3. Se ninguém está sincronizando, verificar o próximo 'pending' da fila
        const nextInQueue = await db.get(
            `SELECT id, equip_validator FROM equip_sync_queue 
             WHERE status = 'pending' 
             ORDER BY created_at ASC LIMIT 1`
        );

        if (!nextInQueue) {
            return res.json({
                success: true,
                is_my_turn: false,
                status: 'idle',
                message: 'Nenhuma sincronização pendente na fila'
            });
        }

        if (nextInQueue.equip_validator === equip_validator) {
            // É a minha vez! Mudar status para 'syncing'
            await db.run(
                `UPDATE equip_sync_queue SET status = 'syncing', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [nextInQueue.id]
            );

            return res.json({
                success: true,
                is_my_turn: true,
                status: 'syncing',
                message: 'Sua vez de sincronizar começou'
            });
        }

        return res.json({
            success: true,
            is_my_turn: false,
            status: 'waiting',
            message: 'Aguardando sua vez na fila'
        });
    });

    // GET /api/comunicador/sync/data?tenant_id=...&equip_validator=...
    // Retorna dados filtrados pelas regras de acesso do equipamento.
    // Visitantes (on_premises) são sempre incluídos independente da regra.
    getSyncData = asyncHandler(async (req, res) => {
        const { tenant_id, equip_validator, page = 1, limit = 500 } = req.query;

        if (!tenant_id || !equip_validator) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        const activeJob = await db.get(
            `SELECT id FROM equip_sync_queue
             WHERE equip_validator = ? AND status = 'syncing'
             LIMIT 1`,
            [equip_validator]
        );

        if (!activeJob) {
            return res.status(403).json({
                success: false,
                message: 'Você não tem uma sessão de sincronização ativa. Chame /sync/check primeiro.'
            });
        }

        // ── Resolver filtro de pessoas pelas regras de acesso ─────────────────
        // personIds = null  → sem filtro (envia todos)
        // personIds = Set   → envia apenas esses IDs
        let personIds = null;

        const equip = await db.get(
            `SELECT id FROM equipments WHERE validador = ? AND active = 1 LIMIT 1`,
            [equip_validator]
        );

        if (equip) {
            const rules = await db.all(
                `SELECT access_type, persons, companies, groups
                 FROM access_rules
                 WHERE active = 1
                   AND (access_target = 'persons' OR access_target IS NULL)
                   AND EXISTS (
                       SELECT 1 FROM json_each(equipments)
                       WHERE CAST(value AS INTEGER) = ?
                   )`,
                [equip.id]
            );

            if (rules.length > 0) {
                const hasAllRule = rules.some(
                    r => r.access_type === 'todos' || r.access_type === 'pessoas-geral'
                );

                if (!hasAllRule) {
                    const idSet = new Set();

                    for (const rule of rules) {
                        if (rule.access_type === 'pessoas-especificas') {
                            const ids = JSON.parse(rule.persons || '[]');
                            ids.forEach(id => idSet.add(Number(id)));

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
                                    `SELECT id FROM persons
                                     WHERE status = 'active' AND company_id IN (${ph})`,
                                    companyIds
                                );
                                rows.forEach(r => idSet.add(r.id));
                            }
                        }
                    }

                    personIds = Array.from(idSet);
                }
            }
        }

        // ── Buscar pessoas conforme filtro ────────────────────────────────────
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let persons = [];
        let totalPersons = 0;

        if (personIds === null) {
            persons = await db.all(
                `SELECT id, name, registration_number, photo_url
                 FROM persons WHERE status = 'active'
                 ORDER BY id ASC LIMIT ? OFFSET ?`,
                [parseInt(limit), offset]
            );
            const row = await db.get(`SELECT COUNT(*) as total FROM persons WHERE status = 'active'`);
            totalPersons = row.total;
        } else if (personIds.length > 0) {
            const ph = personIds.map(() => '?').join(',');
            persons = await db.all(
                `SELECT id, name, registration_number, photo_url
                 FROM persons WHERE status = 'active' AND id IN (${ph})
                 ORDER BY id ASC LIMIT ? OFFSET ?`,
                [...personIds, parseInt(limit), offset]
            );
            const row = await db.get(
                `SELECT COUNT(*) as total FROM persons WHERE status = 'active' AND id IN (${ph})`,
                personIds
            );
            totalPersons = row.total;
        }

        // ── Visitantes: sempre incluir todos os que estão no local ────────────
        const visitors = await db.all(
            `SELECT id, name, registration_number, photo_url
             FROM visitors WHERE status = 'on_premises'
             ORDER BY id ASC`
        );

        // ── Converter para personId (mesma lógica do faceQueueController) ─────
        const toPersonId = (p, isVisitor = false) => {
            if (p.registration_number) {
                const num = Number(p.registration_number);
                if (!Number.isNaN(num)) return num;
            }
            return isVisitor ? p.id + 100000 : p.id;
        };

        const personsData = persons.map(p => ({
            id: toPersonId(p),
            name: p.name,
            registration_number: p.registration_number,
            photo: p.photo_url,
            resolved: 0,
            equip_validator,
            type: 'person'
        }));

        const visitorsData = visitors.map(v => ({
            id: toPersonId(v, true),
            name: v.name,
            registration_number: v.registration_number,
            photo: v.photo_url,
            resolved: 0,
            equip_validator,
            type: 'visitor'
        }));

        const totalGeral = totalPersons + visitors.length;

        return res.json({
            success: true,
            data: [...personsData, ...visitorsData],
            pagination: {
                total: totalGeral,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(totalGeral / parseInt(limit))
            },
            filter_applied: personIds !== null,
            persons_count: persons.length,
            visitors_count: visitors.length
        });
    });

    // POST /api/comunicador/sync/complete
    // Finaliza a sincronização e libera a vez
    completeSync = asyncHandler(async (req, res) => {
        const { tenant_id, equip_validator } = req.body;

        if (!tenant_id || !equip_validator) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        const result = await db.run(
            `UPDATE equip_sync_queue 
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
             WHERE equip_validator = ? AND status = 'syncing'`,
            [equip_validator]
        );

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'Nenhuma sincronização ativa encontrada para este equipamento'
            });
        }

        return res.json({
            success: true,
            message: 'Sincronização finalizada com sucesso. Próximo equipamento liberado.'
        });
    });

    // GET /api/comunicador/persons?tenant_id=...&equip_validator=... (optional)
    // Retorna os personIds que devem estar no equipamento.
    // Quando equip_validator é informado, aplica o mesmo filtro de access_rules
    // que getSyncData usa — usado pelo diff sync para saber o que PRESERVAR.
    getActivePersonIds = asyncHandler(async (req, res) => {
        const { tenant_id, equip_validator } = req.query;

        if (!tenant_id) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetro obrigatório: tenant_id'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        // ── Resolver filtro de access_rules (igual ao getSyncData) ───────────
        let personIdsFilter = null; // null = todos

        if (equip_validator) {
            const equip = await db.get(
                `SELECT id FROM equipments WHERE validador = ? AND active = 1 LIMIT 1`,
                [equip_validator]
            );

            if (equip) {
                const rules = await db.all(
                    `SELECT access_type, persons, companies, groups
                     FROM access_rules
                     WHERE active = 1
                       AND (access_target = 'persons' OR access_target IS NULL)
                       AND EXISTS (
                           SELECT 1 FROM json_each(equipments)
                           WHERE CAST(value AS INTEGER) = ?
                       )`,
                    [equip.id]
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
                                const gids = JSON.parse(rule.groups || '[]');
                                if (gids.length > 0) {
                                    const ph = gids.map(() => '?').join(',');
                                    const rows = await db.all(
                                        `SELECT DISTINCT p.id FROM persons p
                                         LEFT JOIN person_groups pg ON p.id = pg.person_id
                                         WHERE p.status = 'active'
                                           AND (p.group_id IN (${ph}) OR pg.group_id IN (${ph}))`,
                                        [...gids, ...gids]
                                    );
                                    rows.forEach(r => idSet.add(r.id));
                                }
                            } else if (rule.access_type === 'empresas') {
                                const cids = JSON.parse(rule.companies || '[]');
                                if (cids.length > 0) {
                                    const ph = cids.map(() => '?').join(',');
                                    const rows = await db.all(
                                        `SELECT id FROM persons WHERE status = 'active' AND company_id IN (${ph})`,
                                        cids
                                    );
                                    rows.forEach(r => idSet.add(r.id));
                                }
                            }
                        }
                        personIdsFilter = Array.from(idSet);
                    }
                }
            }
        }

        const ids = new Set();

        // ── Pessoas ativas (com filtro se aplicável) ──────────────────────────
        const personCols = await db.all("PRAGMA table_info(persons)");
        const hasRegNumber = personCols.some(c => c.name === 'registration_number');

        let personRows;
        if (personIdsFilter === null) {
            personRows = await db.all(
                `SELECT id, ${hasRegNumber ? 'registration_number' : 'NULL as registration_number'}
                 FROM persons WHERE status = 'active'`
            );
        } else if (personIdsFilter.length > 0) {
            const ph = personIdsFilter.map(() => '?').join(',');
            personRows = await db.all(
                `SELECT id, ${hasRegNumber ? 'registration_number' : 'NULL as registration_number'}
                 FROM persons WHERE status = 'active' AND id IN (${ph})`,
                personIdsFilter
            );
        } else {
            personRows = [];
        }

        for (const p of personRows) {
            ids.add(String(p.id));
            if (p.registration_number) {
                const num = Number(p.registration_number);
                if (!Number.isNaN(num)) ids.add(String(num));
                else ids.add(String(p.registration_number));
            }
        }

        // ── Visitantes on_premises — sempre incluídos em todos os equipamentos
        const visitorCols = await db.all("PRAGMA table_info(visitors)");
        const visitorHasReg = visitorCols.some(c => c.name === 'registration_number');
        const visitors = await db.all(
            `SELECT id, ${visitorHasReg ? 'registration_number' : 'NULL as registration_number'}
             FROM visitors WHERE status = 'on_premises'`
        );
        for (const v of visitors) {
            if (v.registration_number) {
                const num = Number(v.registration_number);
                if (!Number.isNaN(num)) ids.add(String(num));
                else ids.add(String(v.registration_number));
            } else {
                ids.add(String(v.id + 100000));
            }
            ids.add(String(v.id));
        }

        const data = Array.from(ids);
        return res.json({
            success: true,
            data,
            total: data.length,
            filter_applied: personIdsFilter !== null
        });
    });

    // GET /api/comunicador/sync/diff-data?tenant_id=...&equip_validator=...
    // Igual ao getSyncData mas SEM exigir sessão ativa na equip_sync_queue.
    // Usado exclusivamente pelo diff_sync do comunicador no startup/on-demand.
    getDiffSyncData = asyncHandler(async (req, res) => {
        const { tenant_id, equip_validator, page = 1, limit = 500 } = req.query;

        if (!tenant_id || !equip_validator) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetros obrigatórios: tenant_id, equip_validator'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        // ── Resolver filtro de pessoas pelas regras de acesso ─────────────────
        let personIds = null;

        const equip = await db.get(
            `SELECT id FROM equipments WHERE validador = ? AND active = 1 LIMIT 1`,
            [equip_validator]
        );

        if (equip) {
            const rules = await db.all(
                `SELECT access_type, persons, companies, groups
                 FROM access_rules
                 WHERE active = 1
                   AND (access_target = 'persons' OR access_target IS NULL)
                   AND EXISTS (
                       SELECT 1 FROM json_each(equipments)
                       WHERE CAST(value AS INTEGER) = ?
                   )`,
                [equip.id]
            );

            if (rules.length > 0) {
                const hasAllRule = rules.some(
                    r => r.access_type === 'todos' || r.access_type === 'pessoas-geral'
                );

                if (!hasAllRule) {
                    const idSet = new Set();

                    for (const rule of rules) {
                        if (rule.access_type === 'pessoas-especificas') {
                            const ids = JSON.parse(rule.persons || '[]');
                            ids.forEach(id => idSet.add(Number(id)));

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
                                    `SELECT id FROM persons
                                     WHERE status = 'active' AND company_id IN (${ph})`,
                                    companyIds
                                );
                                rows.forEach(r => idSet.add(r.id));
                            }
                        }
                    }

                    personIds = Array.from(idSet);
                }
            }
        }

        // ── Buscar pessoas conforme filtro ────────────────────────────────────
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let persons = [];
        let totalPersons = 0;

        if (personIds === null) {
            persons = await db.all(
                `SELECT id, name, registration_number, photo_url
                 FROM persons WHERE status = 'active'
                 ORDER BY id ASC LIMIT ? OFFSET ?`,
                [parseInt(limit), offset]
            );
            const row = await db.get(`SELECT COUNT(*) as total FROM persons WHERE status = 'active'`);
            totalPersons = row.total;
        } else if (personIds.length > 0) {
            const ph = personIds.map(() => '?').join(',');
            persons = await db.all(
                `SELECT id, name, registration_number, photo_url
                 FROM persons WHERE status = 'active' AND id IN (${ph})
                 ORDER BY id ASC LIMIT ? OFFSET ?`,
                [...personIds, parseInt(limit), offset]
            );
            const row = await db.get(
                `SELECT COUNT(*) as total FROM persons WHERE status = 'active' AND id IN (${ph})`,
                personIds
            );
            totalPersons = row.total;
        }

        // ── Visitantes: sempre incluir todos os que estão no local ────────────
        const visitors = await db.all(
            `SELECT id, name, registration_number, photo_url
             FROM visitors WHERE status = 'on_premises'
             ORDER BY id ASC`
        );

        const toPersonId = (p, isVisitor = false) => {
            if (p.registration_number) {
                const num = Number(p.registration_number);
                if (!Number.isNaN(num)) return num;
            }
            return isVisitor ? p.id + 100000 : p.id;
        };

        const personsData = persons.map(p => ({
            id: toPersonId(p),
            name: p.name,
            registration_number: p.registration_number,
            photo: p.photo_url,
            resolved: 0,
            equip_validator,
            type: 'person'
        }));

        const visitorsData = visitors.map(v => ({
            id: toPersonId(v, true),
            name: v.name,
            registration_number: v.registration_number,
            photo: v.photo_url,
            resolved: 0,
            equip_validator,
            type: 'visitor'
        }));

        const totalGeral = totalPersons + visitors.length;

        return res.json({
            success: true,
            data: [...personsData, ...visitorsData],
            pagination: {
                total: totalGeral,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(totalGeral / parseInt(limit))
            },
            filter_applied: personIds !== null,
            persons_count: persons.length,
            visitors_count: visitors.length
        });
    });

    // POST /api/comunicador/sync/clear
    // Limpa toda a fila de sincronização do tenant
    clearSyncQueue = asyncHandler(async (req, res) => {
        const { tenant_id } = req.body;

        if (!tenant_id) {
            return res.status(400).json({
                success: false,
                message: 'Parâmetro obrigatório: tenant_id'
            });
        }

        const db = await getTenantDatabase(tenant_id);

        const result = await db.run(
            `UPDATE equip_sync_queue 
             SET status = 'canceled', completed_at = CURRENT_TIMESTAMP 
             WHERE status IN ('pending', 'syncing')`
        );

        return res.json({
            success: true,
            message: 'Fila de sincronização limpa com sucesso',
            canceled_count: result.changes
        });
    });
}

export default new SyncController();

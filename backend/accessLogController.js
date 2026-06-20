import { getTenantDatabase } from '../middleware/tenantManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';

// GET /api/access-log/logs
// Lista logs com filtros opcionais: startDate, endDate, equipment_id,
// person_type, action, status, person_id — paginado
export const getAccessLogs = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const {
        page = 1, limit = 50,
        person_id, equipment_id, equipmentId, person_type, action, status,
        startDate, endDate, excludeType, search, plate
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE al.tenant_id = ?';
    const params = [req.tenantId];

    const equip = equipment_id || equipmentId;
    if (person_id)    { where += ' AND al.person_id = ?';    params.push(person_id); }
    if (equip)        { where += ' AND al.equipment_id = ?'; params.push(equip); }
    if (person_type)  { where += ' AND al.person_type = ?';  params.push(person_type); }
    if (excludeType)  { where += ' AND al.person_type != ?'; params.push(excludeType); }
    if (action)       { where += ' AND al.action = ?';       params.push(action); }
    if (status)       { where += ' AND al.status = ?';       params.push(status); }
    if (startDate)    { where += ' AND DATE(al.created_at) >= ?'; params.push(startDate); }
    if (endDate)      { where += ' AND DATE(al.created_at) <= ?'; params.push(endDate); }
    if (plate)        { where += ' AND al.plate LIKE ?';     params.push(`%${plate}%`); }
    if (search)       { where += ' AND (CAST(al.person_id AS TEXT) LIKE ? OR e.name LIKE ?)';
                        params.push(`%${search}%`, `%${search}%`); }

    const joinEquip = 'LEFT JOIN equipments e ON e.id = al.equipment_id';

    const { total } = await db.get(
        `SELECT COUNT(*) as total FROM access_log al ${joinEquip} ${where}`,
        params
    );

    const logs = await db.all(
        `SELECT al.*, e.name AS equipment_name
         FROM access_log al
         ${joinEquip}
         ${where}
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]
    );

    // Enriquecer com nome da pessoa/visitante/veículo
    for (const log of logs) {
        if (log.person_type === 'vehicle') {
            const v = await db.get(
                'SELECT license_plate, model FROM vehicles WHERE id = ?', [log.person_id]
            );
            log.person_name = v ? (v.license_plate || 'Veículo') : 'Veículo';
        } else if (log.person_type === 'visitor') {
            const v = await db.get('SELECT name FROM visitors WHERE id = ?', [log.person_id]);
            log.person_name = v ? v.name : `Visitante #${log.person_id}`;
        } else {
            const p = await db.get('SELECT name FROM persons WHERE id = ?', [log.person_id]);
            log.person_name = p ? p.name : `Pessoa #${log.person_id}`;
        }
    }

    return res.json({
        success: true,
        data: logs,
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(total / parseInt(limit))
        }
    });
});

// GET /api/access-log/last
// Último evento de acesso registrado (qualquer tipo)
export const getLastAccess = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);

    const log = await db.get(
        `SELECT al.*, e.name AS equipment_name
         FROM access_log al
         LEFT JOIN equipments e ON e.id = al.equipment_id
         WHERE al.tenant_id = ?
         ORDER BY al.created_at DESC
         LIMIT 1`,
        [req.tenantId]
    );

    if (!log) {
        return res.json({ success: true, data: null });
    }

    if (log.person_type === 'visitor') {
        const v = await db.get('SELECT name FROM visitors WHERE id = ?', [log.person_id]);
        log.person_name = v ? v.name : `Visitante #${log.person_id}`;
    } else {
        const p = await db.get('SELECT name FROM persons WHERE id = ?', [log.person_id]);
        log.person_name = p ? p.name : `Pessoa #${log.person_id}`;
    }

    return res.json({ success: true, data: log });
});

// GET /api/access-log/stats
// Estatísticas de hoje: entradas, saídas, negados, presentes (entradas - saídas)
export const getTodayStats = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const row = await db.get(
        `SELECT
            SUM(CASE WHEN action = 'ENTRY' AND status = 'SUCCESS' THEN 1 ELSE 0 END) AS entradas,
            SUM(CASE WHEN action = 'EXIT'  AND status = 'SUCCESS' THEN 1 ELSE 0 END) AS saidas,
            SUM(CASE WHEN status = 'DENIED' THEN 1 ELSE 0 END)                        AS negados
         FROM access_log
         WHERE tenant_id = ? AND created_at >= ?`,
        [req.tenantId, today + ' 00:00:00']
    );

    const entradas = row.entradas || 0;
    const saidas   = row.saidas   || 0;
    const negados  = row.negados  || 0;
    const presentes = Math.max(0, entradas - saidas);

    return res.json({
        success: true,
        data: { entradas, saidas, negados, presentes }
    });
});

// GET /api/access-log/history/:personType/:personId
// Histórico completo de acessos de uma pessoa ou visitante específico
export const getPersonAccessHistory = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const { personType, personId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { total } = await db.get(
        `SELECT COUNT(*) as total FROM access_log
         WHERE tenant_id = ? AND person_id = ? AND person_type = ?`,
        [req.tenantId, personId, personType]
    );

    const logs = await db.all(
        `SELECT al.*, e.name AS equipment_name
         FROM access_log al
         LEFT JOIN equipments e ON e.id = al.equipment_id
         WHERE al.tenant_id = ? AND al.person_id = ? AND al.person_type = ?
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`,
        [req.tenantId, personId, personType, parseInt(limit), offset]
    );

    return res.json({
        success: true,
        data: logs,
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(total / parseInt(limit))
        }
    });
});

// GET /api/access-log/equipments
// Lista equipamentos que possuem registros de acesso
export const getEquipments = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);

    const equipments = await db.all(
        `SELECT DISTINCT e.id, e.name, e.ip_address, e.tipo,
                COUNT(al.id) AS total_logs
         FROM access_log al
         LEFT JOIN equipments e ON e.id = al.equipment_id
         WHERE al.tenant_id = ?
         GROUP BY al.equipment_id
         ORDER BY total_logs DESC`,
        [req.tenantId]
    );

    return res.json({ success: true, data: equipments });
});

// DELETE /api/access-log/clear
// Limpa todos os logs do tenant (operação administrativa)
export const clearAccessLogs = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);

    const result = await db.run(
        'DELETE FROM access_log WHERE tenant_id = ?',
        [req.tenantId]
    );

    return res.json({
        success: true,
        message: `${result.changes} log(s) removido(s)`,
        deleted_count: result.changes
    });
});

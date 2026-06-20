import { getTenantDatabase } from '../middleware/tenantManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';

function normalizarPersonType(raw) {
    const v = (raw ?? '').toLowerCase().trim();
    if (v === 'visitor' || v === 'visitante') return 'visitante';
    if (v === 'vehicle' || v === 'veiculo') return 'veiculo';
    if (v === 'employee' || v === 'funcionario') return 'funcionario';
    return 'pessoa';
}

function appendPersonTypeFilter(where, params, personType) {
    if (!personType) return where;
    const pt = String(personType).toLowerCase();
    if (pt === 'pessoa' || pt === 'person') {
        return where + ` AND (al.person_type = 'person' OR al.person_type = 'pessoa')`;
    }
    if (pt === 'visitante' || pt === 'visitor') {
        return where + ` AND (al.person_type = 'visitor' OR al.person_type = 'visitante')`;
    }
    if (pt === 'veiculo' || pt === 'vehicle') {
        return where + ` AND (al.person_type = 'vehicle' OR al.person_type = 'veiculo')`;
    }
    params.push(personType);
    return where + ' AND al.person_type = ?';
}

function appendExcludeTypeFilter(where, params, excludeType) {
    if (!excludeType) return where;
    const ex = String(excludeType).toLowerCase();
    if (ex === 'vehicle' || ex === 'veiculo') {
        return where + ` AND (al.person_type IS NULL OR (al.person_type != 'vehicle' AND al.person_type != 'veiculo'))`;
    }
    params.push(excludeType);
    return where + ' AND (al.person_type IS NULL OR al.person_type != ?)';
}

function buildAccessLogFromClause() {
    return `
        FROM access_log al
        LEFT JOIN equipments e ON e.id = al.equipment_id
        LEFT JOIN persons p ON p.id = al.person_id AND (al.person_type = 'person' OR al.person_type = 'pessoa')
        LEFT JOIN visitors v ON v.id = al.person_id AND (al.person_type = 'visitor' OR al.person_type = 'visitante')
        LEFT JOIN vehicles veh ON veh.id = al.person_id AND (al.person_type = 'vehicle' OR al.person_type = 'veiculo')
        LEFT JOIN persons p_owner ON p_owner.id = veh.person_id
        LEFT JOIN companies c ON c.id = p.company_id
        LEFT JOIN companies comp ON comp.id = veh.company_id
    `;
}

function appendAccessLogFilters(where, params, query) {
    const {
        person_id, equipment_id, equipmentId, person_type, action, status,
        startDate, endDate, excludeType, search, plate, excludeParking, parkingTab
    } = query;

    const equip = equipment_id || equipmentId;
    if (person_id) { where += ' AND al.person_id = ?'; params.push(person_id); }
    if (equip) { where += ' AND al.equipment_id = ?'; params.push(equip); }
    where = appendPersonTypeFilter(where, params, person_type);
    where = appendExcludeTypeFilter(where, params, excludeType);
    if (action) { where += ' AND al.action = ?'; params.push(action); }
    if (status) { where += ' AND al.status = ?'; params.push(status); }
    if (startDate) {
        const start = startDate.includes(' ') || startDate.includes('T') ? startDate : `${startDate} 00:00:00`;
        where += ' AND al.created_at >= ?';
        params.push(start);
    }
    if (endDate) {
        const end = new Date(endDate);
        end.setDate(end.getDate() + 1);
        const nextDay = end.toISOString().split('T')[0] + ' 00:00:00';
        where += ' AND al.created_at < ?';
        params.push(nextDay);
    }
    if (plate) { where += ' AND al.plate LIKE ?'; params.push(`%${plate}%`); }
    if (excludeParking) { where += ' AND (e.controla_estacionamento IS NULL OR e.controla_estacionamento = 0)'; }
    if (parkingTab) { where += ` AND (al.person_type = 'vehicle' OR al.person_type = 'veiculo' OR e.controla_estacionamento = 1)`; }
    if (search) {
        const term = `%${search}%`;
        where += ` AND (
            COALESCE(p.name, v.name, p_owner.name, veh.plate, veh.license_plate, CAST(al.person_id AS TEXT)) LIKE ? OR
            COALESCE(c.trading_name, c.corporate_name, v.visitor_company, comp.trading_name, comp.corporate_name) LIKE ? OR
            EXISTS (SELECT 1 FROM groups g WHERE g.id = p.group_id AND g.name LIKE ?)
        )`;
        params.push(term, term, term);
    }
    return where;
}

// GET /api/access-log/logs
export const getAccessLogs = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    let where = 'WHERE al.tenant_id = ?';
    const params = [req.tenantId];
    where = appendAccessLogFilters(where, params, req.query);

    const fromClause = buildAccessLogFromClause();

    const { total } = await db.get(
        `SELECT COUNT(*) as total ${fromClause} ${where}`,
        params
    );

    const logs = await db.all(
        `SELECT
            al.*,
            e.name AS equipment_name,
            e.equipamento_saida,
            COALESCE(p.name, v.name, p_owner.name, veh.plate, veh.license_plate) AS person_name,
            COALESCE(p.photo_url, v.photo_url) AS person_photo,
            COALESCE(c.trading_name, c.corporate_name, v.visitor_company, comp.trading_name, comp.corporate_name) AS person_company
         ${fromClause}
         ${where}
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, parseInt(limit, 10), offset]
    );

    logs.forEach(log => {
        log.person_type = normalizarPersonType(log.person_type);
    });

    const totalPages = Math.ceil((total || 0) / Math.max(1, parseInt(limit, 10)));

    return res.json({
        success: true,
        data: logs,
        pagination: {
            total: total || 0,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            pages: totalPages,
            totalPages
        }
    });
});

// GET /api/access-log/last
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

    if (log.person_type === 'visitor' || log.person_type === 'visitante') {
        const v = await db.get('SELECT name, photo_url FROM visitors WHERE id = ?', [log.person_id]);
        log.person_name  = v ? v.name : `Visitante #${log.person_id}`;
        log.person_photo = v ? v.photo_url : null;
    } else {
        const p = await db.get('SELECT name, photo_url FROM persons WHERE id = ?', [log.person_id]);
        log.person_name  = p ? p.name : `Pessoa #${log.person_id}`;
        log.person_photo = p ? p.photo_url : null;
    }

    log.person_type = normalizarPersonType(log.person_type);

    return res.json({ success: true, data: log });
});

// GET /api/access-log/stats
export const getTodayStats = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const today = new Date().toISOString().slice(0, 10);
    const tipoTab = req.query.tipo_tab || 'pessoas';

    let tabFilter = '';
    if (tipoTab === 'pessoas') {
        tabFilter = ' AND (e.controla_estacionamento IS NULL OR e.controla_estacionamento = 0)';
    } else if (tipoTab === 'veiculos') {
        tabFilter = ' AND e.controla_estacionamento = 1';
    }

    const row = await db.get(
        `SELECT
            SUM(CASE WHEN al.action = 'ENTRY' AND al.status = 'SUCCESS' THEN 1 ELSE 0 END) AS entradas,
            SUM(CASE WHEN al.action = 'EXIT'  AND al.status = 'SUCCESS' THEN 1 ELSE 0 END) AS saidas,
            SUM(CASE WHEN al.status = 'DENIED' THEN 1 ELSE 0 END)                          AS negados
         FROM access_log al
         LEFT JOIN equipments e ON e.id = al.equipment_id
         WHERE al.tenant_id = ? AND al.created_at >= ?${tabFilter}`,
        [req.tenantId, today + ' 00:00:00']
    );

    const entradas  = row.entradas  || 0;
    const saidas    = row.saidas    || 0;
    const negados   = row.negados   || 0;
    const presentes = Math.max(0, entradas - saidas);
    const total     = entradas + saidas;

    return res.json({
        success: true,
        data: { entradas, saidas, negados, presentes, total }
    });
});

// GET /api/access-log/history/:personType/:personId
export const getPersonAccessHistory = asyncHandler(async (req, res) => {
    const db = await getTenantDatabase(req.tenantId);
    const { personType, personId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

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
        [req.tenantId, personId, personType, parseInt(limit, 10), offset]
    );

    const totalPages = Math.ceil((total || 0) / Math.max(1, parseInt(limit, 10)));

    return res.json({
        success: true,
        data: logs,
        pagination: {
            total: total || 0,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            pages: totalPages,
            totalPages
        }
    });
});

// GET /api/access-log/equipments
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

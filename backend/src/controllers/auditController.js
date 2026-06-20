import { asyncHandler } from '../middleware/errorHandler.js';

export const getLogs = asyncHandler(async (req, res) => {
    const db = req.db;
    const { 
        page = 1, 
        limit = 20, 
        user_id, 
        action, 
        entity_type, 
        startDate, 
        endDate,
        search
    } = req.query;

    const parsedLimit = parseInt(limit);
    const offset = (parseInt(page) - 1) * parsedLimit;

    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];

    if (search) {
        query += ' AND (description LIKE ? OR user_name LIKE ? OR old_values LIKE ? OR new_values LIKE ?)';
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    if (user_id) {
        query += ' AND user_id = ?';
        params.push(user_id);
    }

    if (action) {
        query += ' AND action = ?';
        params.push(action);
    }

    if (entity_type) {
        query += ' AND entity_type = ?';
        params.push(entity_type);
    }

    if (startDate) {
        query += ' AND created_at >= ?';
        params.push(startDate + ' 00:00:00');
    }

    if (endDate) {
        query += ' AND created_at <= ?';
        params.push(endDate + ' 23:59:59');
    }

    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(parsedLimit, offset);

    const resultLogs = await db.all(query, params);
    
    // Normalize datetime string and convert to UTC ISO format for JS frontend
    const logs = resultLogs.map(log => {
        if (log.created_at && !log.created_at.includes('T')) {
            // Convert SQLite "YYYY-MM-DD HH:MM:SS" strictly to standard "YYYY-MM-DDTHH:MM:SSZ"
            log.created_at = log.created_at.replace(' ', 'T') + 'Z';
        }
        return log;
    });

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total').split(' ORDER BY')[0];
    const countParams = params.slice(0, -2);
    const { total } = await db.get(countQuery, countParams);

    res.json({
        success: true,
        data: logs,
        pagination: {
            page: parseInt(page),
            limit: parsedLimit,
            total,
            totalPages: Math.ceil(total / parsedLimit)
        }
    });
});

export const getLogById = asyncHandler(async (req, res) => {
    const db = req.db;
    const { id } = req.params;

    const log = await db.get('SELECT * FROM audit_logs WHERE id = ?', [id]);

    if (!log) {
        return res.status(404).json({
            success: false,
            message: 'Log não encontrado'
        });
    }

    res.json({
        success: true,
        data: log
    });
});

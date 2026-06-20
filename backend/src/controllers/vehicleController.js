import dbManager from '../config/database.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

// Função helper para obter conexão com o banco
async function getDb(tenantId) {
    return await dbManager.getConnection(tenantId);
}

// ── UHF helpers ──────────────────────────────────────────────────────────────

/** Converte "123,4567" → 1234567  |  "1234567" → 1234567  |  null → null */
function uhfTagToInt(tag) {
    if (!tag) return null;
    const s = String(tag).trim();
    const match = s.match(/^(\d+),(\d+)$/);
    if (match) return parseInt(match[1]) * 10000 + parseInt(match[2]);
    if (/^\d+$/.test(s)) return parseInt(s);
    return null;
}

/**
 * Enfileira tarefas UHF para todos os equipamentos IDUHF ativos do tenant.
 * taskType: 'register_uhf_card' | 'delete_uhf_card'
 */
async function queueUhfTasks(db, tenantId, taskType, payload) {
    try {
        const equipamentos = await db.all(
            `SELECT validador FROM equipments WHERE tipo = 'uhf' AND active = 1`
        );
        for (const equip of equipamentos) {
            if (!equip.validador) continue;
            await db.run(
                `INSERT INTO access_tasks (tenant_id, equip_validator, task_type, resolved, payload, created_at)
                 VALUES (?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`,
                [tenantId, equip.validador, taskType, JSON.stringify(payload)]
            );
        }
        if (equipamentos.length > 0) {
            console.log(`[UHF] ${equipamentos.length} tarefa(s) "${taskType}" enfileirada(s) para tenant ${tenantId}`);
        }
    } catch (e) {
        console.error('[UHF] Erro ao enfileirar tarefas:', e.message);
    }
}

// Listar todos os veículos
export const list = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { page = 1, limit = 50, search, status } = req.query;
    
    console.log('[DEBUG] Vehicle list - tenantId:', tenantId);
    const db = await getDb(tenantId);
    
    // Parse pagination parameters
    const parsedLimit = Math.min(parseInt(limit) || 50, 10000); // Max 10000 per page
    const offset = (page - 1) * parsedLimit;
    
    // Build query with conditions - OTIMIZADO: sem ORDER BY para ser mais rápido
    let whereClause = '1=1';
    const params = [];
    
    if (status) {
        whereClause += ' AND v.status = ?';
        params.push(status);
    }
    
    if (search) {
        whereClause += ` AND (
            v.plate LIKE ? OR 
            v.license_plate LIKE ? OR 
            v.brand LIKE ? OR 
            v.model LIKE ? OR
            v.observacao LIKE ? OR
            EXISTS (SELECT 1 FROM persons p2 WHERE p2.id = v.person_id AND p2.name LIKE ?)
        )`;
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // Query com JOIN para buscar veículos com dados relacionados
    const query = `
        SELECT v.*
        FROM vehicles v
        WHERE ${whereClause}
        LIMIT ? OFFSET ?
    `;
    
    const vehicles = await db.all(query, [...params, parsedLimit, offset]);
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM vehicles v WHERE ${whereClause}`;
    const { total } = await db.get(countQuery, params);
    
    console.log('[DEBUG] Vehicle list - found:', vehicles.length, 'total:', total);
    
    // Se houver veículos, buscar dados relacionados de uma vez
    if (vehicles.length > 0) {
        // Buscar pessoas
        const personIds = [...new Set(vehicles.filter(v => v.person_id).map(v => v.person_id))];
        const companyIds = [...new Set(vehicles.filter(v => v.company_id).map(v => v.company_id))];
        const parkingIds = [...new Set(vehicles.filter(v => v.parking_id).map(v => v.parking_id))];
        
        const personMap = new Map();
        const companyMap = new Map();
        const parkingMap = new Map();
        
        if (personIds.length > 0) {
            const persons = await db.all(
                `SELECT id, name, cpf FROM persons WHERE id IN (${personIds.map(() => '?').join(',')})`,
                personIds
            );
            persons.forEach(p => personMap.set(p.id, p));
        }
        
        if (companyIds.length > 0) {
            // Verificar schema da tabela companies
            let companies;
            try {
                companies = await db.all(
                    `SELECT id, corporate_name, trading_name FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`,
                    companyIds
                );
            } catch(e) {
                // Se falhar, tentar sem corporate_name
                companies = await db.all(
                    `SELECT id, name FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`,
                    companyIds
                );
            }
            if (companies) {
                companies.forEach(c => companyMap.set(c.id, c));
            }
        }
        
        if (parkingIds.length > 0) {
            // Verificar schema da tabela parkings
            let parkings;
            try {
                parkings = await db.all(
                    `SELECT id, name, description FROM parkings WHERE id IN (${parkingIds.map(() => '?').join(',')})`,
                    parkingIds
                );
            } catch(e) {
                // Se falhar, tentar só com name
                parkings = await db.all(
                    `SELECT id, name FROM parkings WHERE id IN (${parkingIds.map(() => '?').join(',')})`,
                    parkingIds
                );
            }
            if (parkings) {
                parkings.forEach(p => parkingMap.set(p.id, p));
            }
        }
        
        // Agora adicionar os dados aos veículos
        vehicles.forEach(v => {
            const pessoa = personMap.get(v.person_id);
            const empresa = companyMap.get(v.company_id);
            const parking = parkingMap.get(v.parking_id);
            
            v.person_name = pessoa?.name || null;
            v.person_cpf = pessoa?.cpf || null;
            v.company_name = empresa?.corporate_name || empresa?.trading_name || empresa?.name || null;
            v.parking_name = parking?.name || parking?.description || null;
            v.vaga_tipo = v.company_id ? 'rotativa' : (v.parking_id ? 'fixa' : null);
        });
    }
    
    res.json({
        success: true,
        data: vehicles,
        pagination: {
            page: parseInt(page),
            limit: parseInt(parsedLimit),
            total: total,
            totalPages: Math.ceil(total / parsedLimit)
        }
    });
});

// Obter veículo por ID
export const getById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const vehicle = await db.get(`
        SELECT v.*, p.name as person_name
        FROM vehicles v
        LEFT JOIN persons p ON v.person_id = p.id
        WHERE v.id = ?
    `, [id]);
    
    if (!vehicle) {
        return res.status(404).json({
            success: false,
            message: 'Veículo não encontrado'
        });
    }
    
    res.json({
        success: true,
        data: vehicle
    });
});

// Criar veículo
export const create = asyncHandler(async (req, res) => {
    const { person_id, license_plate, brand, model, color, year, company_id, parking_id, plate, status, tag_number, spot_number, uhf_tag, observacao } = req.body;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);

    // Verificar se a placa já existe
    const existing = await db.get('SELECT id FROM vehicles WHERE license_plate = ? OR plate = ?', [license_plate, plate || license_plate]);
    if (existing) {
        return res.status(400).json({
            success: false,
            message: 'Veículo com esta placa já existe'
        });
    }

    // Verificar unicidade da tag UHF (dentro do tenant)
    if (uhf_tag) {
        const tagExisting = await db.get('SELECT id FROM vehicles WHERE uhf_tag = ?', [uhf_tag]);
        if (tagExisting) {
            return res.status(400).json({ success: false, message: 'Tag UHF já cadastrada em outro veículo' });
        }
    }

    const result = await db.run(
        `INSERT INTO vehicles (person_id, license_plate, brand, model, color, year, plate, status, company_id, parking_id, tag_number, spot_number, uhf_tag, observacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [person_id, license_plate, brand, model, color, year, plate || license_plate, status || 'inactive', company_id || null, parking_id || null, tag_number || null, spot_number || null, uhf_tag || null, observacao || null]
    );
    
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ?', [result.lastID]);

    // Enfileira registro de tag UHF nos equipamentos IDUHF
    if (uhf_tag) {
        const person = person_id
            ? await db.get('SELECT registration_number FROM persons WHERE id = ?', [person_id])
            : null;
        await queueUhfTasks(db, tenantId, 'register_uhf_card', {
            uhf_tag,
            uhf_tag_int:         uhfTagToInt(uhf_tag),
            registration_number: person?.registration_number || null,
            vehicle_id:          vehicle.id
        });
    }

    res.json({ success: true, data: vehicle, message: 'Veículo cadastrado com sucesso' });
    await auditService.logCreate(req, { entityType: 'vehicle', entityId: vehicle.id, description: `Veículo cadastrado: ${vehicle.plate}`, newData: vehicle });
});

// Atualizar veículo
export const update = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { person_id, license_plate, brand, model, color, year, company_id, parking_id, plate, status, tag_number, spot_number, uhf_tag, observacao } = req.body;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);

    // Verificar se o veículo existe
    const oldVehicle = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);
    const existing = oldVehicle;
    if (!existing) {
        return res.status(404).json({
            success: false,
            message: 'Veículo não encontrado'
        });
    }

    // Verificar unicidade da tag UHF (excluindo o próprio veículo)
    if (uhf_tag) {
        const tagExisting = await db.get('SELECT id FROM vehicles WHERE uhf_tag = ? AND id != ?', [uhf_tag, id]);
        if (tagExisting) {
            return res.status(400).json({ success: false, message: 'Tag UHF já cadastrada em outro veículo' });
        }
    }

    await db.run(
        `UPDATE vehicles
         SET person_id = ?, license_plate = ?, brand = ?, model = ?, color = ?,
             year = ?, plate = ?, status = ?, company_id = ?, parking_id = ?,
             tag_number = ?, spot_number = ?, uhf_tag = ?, observacao = ?
         WHERE id = ?`,
        [person_id, license_plate, brand, model, color, year,
         plate || license_plate, status,
         company_id || null, parking_id || null,
         tag_number || null, spot_number || null,
         uhf_tag || null, observacao || null,
         id]
    );
    
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);

    // Enfileira tarefas UHF se a tag mudou
    const oldTag = oldVehicle.uhf_tag || null;
    const newTag = uhf_tag || null;
    if (oldTag !== newTag) {
        if (oldTag) {
            await queueUhfTasks(db, tenantId, 'delete_uhf_card', {
                uhf_tag:     oldTag,
                uhf_tag_int: uhfTagToInt(oldTag)
            });
        }
        if (newTag) {
            const person = person_id
                ? await db.get('SELECT registration_number FROM persons WHERE id = ?', [person_id])
                : null;
            await queueUhfTasks(db, tenantId, 'register_uhf_card', {
                uhf_tag:             newTag,
                uhf_tag_int:         uhfTagToInt(newTag),
                registration_number: person?.registration_number || null,
                vehicle_id:          parseInt(id)
            });
        }
    }

    res.json({ success: true, data: vehicle, message: 'Veículo atualizado com sucesso' });
    await auditService.logUpdate(req, { entityType: 'vehicle', entityId: id, description: `Veículo atualizado: ${vehicle.plate}`, oldData: oldVehicle, newData: vehicle });
});

// Excluir veículo
export const remove = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const existing = await db.get('SELECT * FROM vehicles WHERE id = ?', [id]);
    if (!existing) {
        return res.status(404).json({
            success: false,
            message: 'Veículo não encontrado'
        });
    }
    
    // Enfileira remoção da tag UHF antes de excluir o veículo
    if (existing.uhf_tag) {
        await queueUhfTasks(db, tenantId, 'delete_uhf_card', {
            uhf_tag:     existing.uhf_tag,
            uhf_tag_int: uhfTagToInt(existing.uhf_tag)
        });
    }

    await db.run('DELETE FROM vehicles WHERE id = ?', [id]);

    res.json({ success: true, message: 'Veículo excluído com sucesso' });
    await auditService.logDelete(req, { entityType: 'vehicle', entityId: id, description: `Veículo excluído (ID: ${id})`, oldData: existing });
});

// Corrigir veículos importados sem brand (problema na importação Layout 2)
export const fixImportedVehicles = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    // Buscar veículos que têm model mas não têm brand
    const vehiclesWithoutBrand = await db.all(`
        SELECT id, model FROM vehicles 
        WHERE (brand IS NULL OR brand = '') AND model IS NOT NULL AND model != ''
    `);
    
    console.log(`[FIX] Veículos sem brand encontrados: ${vehiclesWithoutBrand.length}`);
    
    let fixed = 0;
    for (const v of vehiclesWithoutBrand) {
        // Tentar separar brand e model - o primeiro espaço separa brand de modelo
        const modelStr = v.model;
        const firstSpaceIndex = modelStr.indexOf(' ');
        
        if (firstSpaceIndex > 0) {
            const brand = modelStr.substring(0, firstSpaceIndex);
            const model = modelStr.substring(firstSpaceIndex + 1);
            
            await db.run(
                'UPDATE vehicles SET brand = ?, model = ? WHERE id = ?',
                [brand, model, v.id]
            );
            fixed++;
            console.log(`[FIX] Veículo ${v.id}: brand=${brand}, model=${model}`);
        }
    }
    
    res.json({
        success: true,
        message: `${fixed} veículos corrigidos`,
        fixed
    });
});

// Buscar veículos que estão no estacionamento
// Fonte de verdade: vehicles.status = 'active' (mantido pelo autorizador)
export const getVehiclesInParking = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { search } = req.query;
    const db = await getDb(tenantId);

    let query = `
        SELECT
            v.id as vehicle_id,
            v.plate,
            v.brand,
            v.model,
            v.color,
            v.parking_id,
            v.company_id as vehicle_company_id,
            v.person_id,
            p.name as person_name,
            COALESCE(c.trading_name, c.corporate_name) as company_name,
            pk.name as parking_name,
            (SELECT al.created_at FROM access_log al
             WHERE al.access_type = 'VEHICLE' AND al.vehicle_id = v.id
               AND al.action = 'ENTRY' AND al.status = 'SUCCESS'
             ORDER BY al.created_at DESC LIMIT 1) as entry_time,
            (SELECT e.name FROM access_log al
             LEFT JOIN equipments e ON al.equipment_id = e.id
             WHERE al.access_type = 'VEHICLE' AND al.vehicle_id = v.id
               AND al.action = 'ENTRY' AND al.status = 'SUCCESS'
             ORDER BY al.created_at DESC LIMIT 1) as equipment_name
        FROM vehicles v
        LEFT JOIN persons p ON v.person_id = p.id
        LEFT JOIN companies c ON COALESCE(v.company_id, p.company_id) = c.id
        LEFT JOIN parkings pk ON v.parking_id = pk.id
        WHERE v.status = 'active'
    `;

    const params = [];

    if (search) {
        query += ` AND (v.plate LIKE ? OR p.name LIKE ? OR c.trading_name LIKE ? OR c.corporate_name LIKE ?)`;
        const searchTerm = `%${search}%`;
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    query += ` ORDER BY entry_time DESC`;

    const vehiclesInParking = await db.all(query, params);

    res.json({
        success: true,
        data: vehiclesInParking,
        totalInParking: vehiclesInParking.length
    });
});

// Registrar saída manual de veículo
export const registerManualExit = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { vehicle_id, plate, reason, person_name } = req.body;
    const db = await getDb(tenantId);
    
    if (!vehicle_id && !plate && !person_name) {
        return res.status(400).json({
            success: false,
            message: 'ID do veículo, placa ou nome da pessoa é obrigatório'
        });
    }
    
    // Buscar o veículo/pessoa nos logs de entrada
    let entryLog;
    
    // Primeiro tenta buscar por vehicle_id se disponível
    if (vehicle_id) {
        entryLog = await db.get(`
            SELECT * FROM access_log 
            WHERE person_type = 'vehicle' 
              AND vehicle_id = ? 
              AND action = 'ENTRY' 
              AND status = 'SUCCESS'
            ORDER BY created_at DESC LIMIT 1
        `, [vehicle_id]);
    }
    
    // Se não encontrou por vehicle_id, tenta por plate
    if (!entryLog && plate) {
        entryLog = await db.get(`
            SELECT * FROM access_log 
            WHERE person_type = 'vehicle' 
              AND (plate = ? OR plate LIKE ?)
              AND action = 'ENTRY' 
              AND status = 'SUCCESS'
            ORDER BY created_at DESC LIMIT 1
        `, [plate.toUpperCase(), `%${plate.toUpperCase()}%`]);
    }
    
    // Se ainda não encontrou, tenta buscar por person_name (pessoas sem veículo)
    if (!entryLog && person_name) {
        const person = await db.get(
            'SELECT id FROM persons WHERE name = ?',
            [person_name]
        );
        
        if (person) {
            entryLog = await db.get(`
                SELECT * FROM access_log 
                WHERE person_id = ?
                  AND action = 'ENTRY' 
                  AND status = 'SUCCESS'
                ORDER BY created_at DESC LIMIT 1
            `, [person.id]);
        }
    }
    
    if (!entryLog) {
        return res.status(404).json({
            success: false,
            message: 'Não há registro de entrada para este veículo ou pessoa'
        });
    }
    
    // Verificar se já houve saída
    let exitLog;
    if (entryLog.vehicle_id) {
        exitLog = await db.get(`
            SELECT id FROM access_log 
            WHERE vehicle_id = ? 
              AND action = 'EXIT' 
              AND status = 'SUCCESS'
              AND created_at > ?
            ORDER BY created_at DESC LIMIT 1
        `, [entryLog.vehicle_id, entryLog.created_at]);
    } else if (entryLog.person_id) {
        exitLog = await db.get(`
            SELECT id FROM access_log 
            WHERE person_id = ? 
              AND action = 'EXIT' 
              AND status = 'SUCCESS'
              AND created_at > ?
            ORDER BY created_at DESC LIMIT 1
        `, [entryLog.person_id, entryLog.created_at]);
    }
    
    if (exitLog) {
        return res.status(400).json({
            success: false,
            message: 'Esta pessoa ou veículo já saiu do estacionamento'
        });
    }
    
    const companyId = entryLog.company_id;
    const personId = entryLog.person_id;
    const equipmentId = entryLog.equipment_id;
    const personType = entryLog.person_type || 'vehicle';
    
    let personNameResolved = 'Desconhecido';
    if (entryLog.vehicle_id) {
        const vehicle = await db.get('SELECT p.name as person_name FROM vehicles v JOIN persons p ON v.person_id = p.id WHERE v.id = ?', [entryLog.vehicle_id]);
        if (vehicle) personNameResolved = vehicle.person_name;
    } else if (personId) {
        const person = await db.get('SELECT name FROM persons WHERE id = ?', [personId]);
        if (person) personNameResolved = person.name;
    }
    
    // Registrar log de saída manual
    await db.run(
        `INSERT INTO access_log (tenant_id, person_id, person_type, equipment_id, action, status, message, created_at, vehicle_id, plate, company_id, access_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, personId, personType, equipmentId, 'EXIT', 'SUCCESS', `Saída manual: ${reason || 'Registro manual'}`, new Date().toISOString(), entryLog.vehicle_id, entryLog.plate, companyId, 'VEHICLE']
    );
    
    // Atualizar status da pessoa
    if (personId) {
        await db.run(
            'UPDATE persons SET on_premisse = 0, exited = 1 WHERE id = ?',
            [personId]
        );
    }
    
    // Atualizar status do veículo
    if (entryLog.vehicle_id) {
        await db.run(
            'UPDATE vehicles SET status = ?, parking_id = NULL WHERE id = ?',
            ['inactive', entryLog.vehicle_id]
        );
    }
    
    // Liberar vaga da empresa
    if (companyId && equipmentId) {
        try {
            const equipment = await db.get(
                'SELECT controla_estacionamento FROM equipments WHERE id = ?',
                [equipmentId]
            );
            
            if (equipment && equipment.controla_estacionamento === 1) {
                await db.run(
                    'UPDATE parking_companies SET vagas_ocupadas = vagas_ocupadas - 1 WHERE company_id = ? AND vagas_ocupadas > 0',
                    [companyId]
                );
            }
        } catch (e) {
            console.log('Erro ao atualizar vagas:', e.message);
        }
    }
    
    res.json({
        success: true,
        message: 'Saída registrada com sucesso.',
        data: {
            plate: entryLog.plate,
            person_name: personNameResolved
        }
    });
});

// Obter estatísticas de veículos no estacionamento
export const getVehicleStats = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    const today = new Date().toISOString().slice(0, 10);

    const row = await db.get(`
        SELECT
            SUM(CASE WHEN al.action = 'ENTRY' AND al.status = 'SUCCESS' THEN 1 ELSE 0 END) AS entradas,
            SUM(CASE WHEN al.action = 'EXIT'  AND al.status = 'SUCCESS' THEN 1 ELSE 0 END) AS saidas
        FROM access_log al
        LEFT JOIN equipments e ON e.id = al.equipment_id
        WHERE al.tenant_id = ?
          AND al.created_at >= ?
          AND (al.access_type = 'VEHICLE' OR e.controla_estacionamento = 1)
    `, [tenantId, today + ' 00:00:00']);

    const entradas = row.entradas || 0;
    const saidas   = row.saidas   || 0;
    const noLocal  = Math.max(0, entradas - saidas);

    res.json({
        success: true,
        total: entradas + saidas,
        entradas,
        saidas,
        noLocal
    });
});

// Resetar estado do estacionamento
export const resetParking = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    await db.run("UPDATE vehicles SET status = 'inactive', parking_id = NULL WHERE status = 'active'");
    await db.run("UPDATE persons SET on_premisse = 0, exited = 0 WHERE on_premisse = 1 OR exited = 1");
    try {
        await db.run("UPDATE parking_companies SET vagas_ocupadas = 0");
    } catch(e) {}
    
    res.json({ success: true, message: 'Estacionamento resetado com sucesso' });
});

// Registrar entrada manual de pessoa/veículo
export const registerManualEntry = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { person_id, vehicle_id, plate, reason } = req.body;
    const db = await getDb(tenantId);

    if (!person_id) {
        return res.status(400).json({ success: false, message: 'ID da pessoa é obrigatório' });
    }

    const person = await db.get('SELECT id, name, company_id FROM persons WHERE id = ?', [person_id]);
    if (!person) {
        return res.status(404).json({ success: false, message: 'Pessoa não encontrada' });
    }

    let resolvedPlate = plate || null;
    if (vehicle_id && !resolvedPlate) {
        const veh = await db.get('SELECT plate, license_plate FROM vehicles WHERE id = ?', [vehicle_id]);
        if (veh) resolvedPlate = veh.plate || veh.license_plate || null;
    }

    await db.run(
        `INSERT INTO access_log (tenant_id, person_id, person_type, action, status, message, created_at, vehicle_id, plate, company_id, access_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, person_id, 'vehicle', 'ENTRY', 'SUCCESS', `Entrada manual: ${reason || 'Registro manual'}`, new Date().toISOString(), vehicle_id || null, resolvedPlate, person.company_id || null, 'VEHICLE']
    );

    try {
        await db.run('UPDATE persons SET on_premisse = 1, exited = 0 WHERE id = ?', [person_id]);
    } catch (e) {}

    if (vehicle_id) {
        await db.run("UPDATE vehicles SET status = 'active' WHERE id = ?", [vehicle_id]);
    }

    res.json({ success: true, message: 'Entrada registrada com sucesso.' });
});

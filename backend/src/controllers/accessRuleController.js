import dbManager from '../config/database.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { invalidateCache } from '../services/autorizadorService.js';
import { invalidate as invalidateResolverCache } from '../services/accessRuleResolver.js';
import { triggerResyncForEquipments, unionEquipmentIds } from '../services/equipmentPushSync.js';
import { notifyPushInvalidateCache } from '../services/pushOutbox.js';
import auditService from '../services/auditService.js';

// Helper para obter conexão do banco
async function getDb(tenantId) {
    return await dbManager.getConnection(tenantId);
}

// Listar todas as regras de acesso
export const list = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    const accessTarget = req.query.access_target;
    
    let query = 'SELECT * FROM access_rules WHERE tenant_id = ? AND active = 1';
    let params = [tenantId];
    
    if (accessTarget) {
        query += ' AND access_target = ?';
        params.push(accessTarget);
    }
    
    query += ' ORDER BY name ASC';
    
    const rules = await db.all(query, params);
    
    // Parse JSON fields
    const parsedRules = rules.map(rule => ({
        ...rule,
        persons: rule.persons ? JSON.parse(rule.persons) : [],
        companies: rule.companies ? JSON.parse(rule.companies) : [],
        groups: rule.groups ? JSON.parse(rule.groups) : [],
        equipments: rule.equipments ? JSON.parse(rule.equipments) : [],
        schedules: rule.schedules ? JSON.parse(rule.schedules) : [],
        vehicles: rule.vehicles ? JSON.parse(rule.vehicles) : [],
        vehicle_companies: rule.vehicle_companies ? JSON.parse(rule.vehicle_companies) : [],
        parkings: rule.parkings ? JSON.parse(rule.parkings) : []
    }));
    
    res.json({
        success: true,
        data: parsedRules
    });
});

// Obter uma regra pelo ID
export const getById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    const rule = await db.get(
        `SELECT * FROM access_rules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!rule) {
        return res.status(404).json({
            success: false,
            message: 'Regra de acesso não encontrada'
        });
    }
    
    // Parse JSON fields
    const parsedRule = {
        ...rule,
        persons: rule.persons ? JSON.parse(rule.persons) : [],
        companies: rule.companies ? JSON.parse(rule.companies) : [],
        groups: rule.groups ? JSON.parse(rule.groups) : [],
        equipments: rule.equipments ? JSON.parse(rule.equipments) : [],
        schedules: rule.schedules ? JSON.parse(rule.schedules) : [],
        vehicles: rule.vehicles ? JSON.parse(rule.vehicles) : [],
        vehicle_companies: rule.vehicle_companies ? JSON.parse(rule.vehicle_companies) : [],
        parkings: rule.parkings ? JSON.parse(rule.parkings) : []
    };
    
    res.json({
        success: true,
        data: parsedRule
    });
});

// Criar nova regra de acesso
export const create = asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    console.log('=== CREATE ACCESS RULE ===');
    console.log('Tenant ID:', tenantId);
    console.log('Request body:', req.body);
    
    const { 
        name, 
        access_type, 
        persons, 
        companies, 
        groups, 
        equipments, 
        schedule_type,
        schedules,
        access_target,
        vehicles,
        vehicle_companies,
        parkings,
        parking_type,
        max_vehicles
    } = req.body;
    
    // Validar campos obrigatórios
    if (!name) {
        return res.status(400).json({
            success: false,
            message: 'Nome da regra é obrigatório'
        });
    }
    
    // Equipamentos são opcionais - se não selecionados, a regra se aplica a qualquer equipamento
    const equipmentsArray = equipments && Array.isArray(equipments) ? equipments : [];
    
    if (schedule_type === 'especifico' && (!schedules || !Array.isArray(schedules) || schedules.length === 0)) {
        return res.status(400).json({
            success: false,
            message: 'Selecione pelo menos um horário'
        });
    }
    
    // Se access_type for 'todos', não precisa de persons/companies/groups
    // Se for 'pessoas-especificas', precisa de persons
    // Se for 'empresas', precisa de companies
    // Se for 'grupos', precisa de groups
    if (access_type === 'pessoas-especificas' && (!persons || !Array.isArray(persons) || persons.length === 0)) {
        return res.status(400).json({
            success: false,
            message: 'Selecione pelo menos uma pessoa'
        });
    }
    
    if (access_type === 'empresas' && (!companies || !Array.isArray(companies) || companies.length === 0)) {
        return res.status(400).json({
            success: false,
            message: 'Selecione pelo menos uma empresa'
        });
    }
    
    if (access_type === 'grupos' && (!groups || !Array.isArray(groups) || groups.length === 0)) {
        return res.status(400).json({
            success: false,
            message: 'Selecione pelo menos um grupo'
        });
    }
    
    // Converter arrays para JSON
    const personsJson = persons ? JSON.stringify(persons) : null;
    const companiesJson = companies ? JSON.stringify(companies) : null;
    const groupsJson = groups ? JSON.stringify(groups) : null;
    const equipmentsJson = JSON.stringify(equipmentsArray);
    const schedulesJson = schedules ? JSON.stringify(schedules) : null;
    
    // Vehicle fields
    const vehiclesJson = vehicles ? JSON.stringify(vehicles) : null;
    const vehicleCompaniesJson = vehicle_companies ? JSON.stringify(vehicle_companies) : null;
    const parkingsJson = parkings ? JSON.stringify(parkings) : null;
    
    console.log('=== DEBUG CREATE RULE ===');
    console.log('groups received:', groups);
    console.log('groupsJson:', groupsJson);
    console.log('equipments received:', equipmentsArray);
    console.log('equipmentsJson:', equipmentsJson);
    
    console.log('Inserindo no banco de dados...');
    const result = await db.run(
        `INSERT INTO access_rules 
         (tenant_id, name, access_type, persons, companies, groups, equipments, schedule_type, schedules, active, created_at, updated_at,
          access_target, vehicles, vehicle_companies, parkings, parking_type, max_vehicles) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?)`,
        [tenantId, name, access_type || 'pessoas-especificas', personsJson, companiesJson, groupsJson, equipmentsJson, schedule_type || 'especifico', schedulesJson,
         access_target || 'persons', vehiclesJson, vehicleCompaniesJson, parkingsJson, parking_type, max_vehicles]
    );
    
    console.log('Insert result:', result);
    
    const newRule = await db.get(
        `SELECT * FROM access_rules WHERE id = ?`,
        [result.lastID]
    );
    
    console.log(`Regra de acesso criada: ${name} para tenant ${tenantId}`);
    console.log('Nova regra:', newRule);
    
    // Invalidar caches (autorizador online + resolver de batch)
    invalidateCache(tenantId);
    invalidateResolverCache(tenantId);

    res.json({
        success: true,
        data: {
            ...newRule,
            persons: persons || [],
            companies: companies || [],
            groups: groups || [],
            equipments: equipmentsArray,
            schedules: schedules || [],
            vehicles: vehicles || [],
            vehicle_companies: vehicle_companies || [],
            parkings: parkings || []
        },
        message: 'Regra de acesso criada com sucesso'
    });

    // Log audit
    await auditService.logCreate(req, 'access_rule', newRule.id, `Criação de regra de acesso: ${newRule.name}`, newRule);

    // Push: regra nova → ressincroniza equipments listados (fire-and-forget,
    // não bloqueia response — UI já recebeu success).
    try {
        await triggerResyncForEquipments(db, tenantId, equipmentsArray);
    } catch (err) {
        console.error('[rule:create] resync falhou:', err.message);
    }
});

// Atualizar regra de acesso
export const update = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    // Verificar se a regra existe
    const existingRule = await db.get(
        `SELECT * FROM access_rules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!existingRule) {
        return res.status(404).json({
            success: false,
            message: 'Regra de acesso não encontrada'
        });
    }
    
    const { 
        name, 
        access_type, 
        persons, 
        companies, 
        groups, 
        equipments, 
        schedule_type,
        schedules,
        active,
        access_target,
        vehicles,
        vehicle_companies,
        parkings,
        parking_type,
        max_vehicles
    } = req.body;
    
    // Validar campos obrigatórios
    if (!name) {
        return res.status(400).json({
            success: false,
            message: 'Nome da regra é obrigatório'
        });
    }
    
    // Equipamentos são opcionais - se não selecionados, a regra se aplica a qualquer equipamento
    const equipmentsArray = equipments && Array.isArray(equipments) ? equipments : [];
    
    if (schedule_type === 'especifico' && (!schedules || !Array.isArray(schedules) || schedules.length === 0)) {
        return res.status(400).json({
            success: false,
            message: 'Selecione pelo menos um horário'
        });
    }
    
    // Converter arrays para JSON
    const personsJson = persons ? JSON.stringify(persons) : null;
    const companiesJson = companies ? JSON.stringify(companies) : null;
    const groupsJson = groups ? JSON.stringify(groups) : null;
    const equipmentsJson = JSON.stringify(equipmentsArray);
    const schedulesJson = schedules ? JSON.stringify(schedules) : null;
    
    // Vehicle fields
    const vehiclesJson = vehicles ? JSON.stringify(vehicles) : null;
    const vehicleCompaniesJson = vehicle_companies ? JSON.stringify(vehicle_companies) : null;
    const parkingsJson = parkings ? JSON.stringify(parkings) : null;
    
    console.log('=== DEBUG UPDATE RULE ===');
    console.log('groups received:', groups);
    console.log('groupsJson:', groupsJson);
    console.log('equipments received:', equipmentsArray);
    console.log('equipmentsJson:', equipmentsJson);
    
    await db.run(
        `UPDATE access_rules 
         SET name = ?, access_type = ?, persons = ?, companies = ?, groups = ?, 
             equipments = ?, schedule_type = ?, schedules = ?, active = ?, updated_at = datetime('now'),
             access_target = ?, vehicles = ?, vehicle_companies = ?, parkings = ?, parking_type = ?, max_vehicles = ?
         WHERE id = ? AND tenant_id = ?`,
        [name, access_type || 'pessoas-especificas', personsJson, companiesJson, groupsJson, 
         equipmentsJson, schedule_type || 'especifico', schedulesJson, active !== undefined ? active : 1,
         access_target || 'persons', vehiclesJson, vehicleCompaniesJson, parkingsJson, parking_type, max_vehicles,
         id, tenantId]
    );
    
    const updatedRule = await db.get(
        `SELECT * FROM access_rules WHERE id = ?`,
        [id]
    );

    console.log(`Regra de acesso atualizada: ${name} para tenant ${tenantId}`);

    // Invalidar caches LOCAIS + notificar Push (outro processo)
    invalidateCache(tenantId);
    invalidateResolverCache(tenantId);
    notifyPushInvalidateCache(tenantId);

    res.json({
        success: true,
        data: {
            ...updatedRule,
            persons: persons || [],
            companies: companies || [],
            groups: groups || [],
            equipments: equipmentsArray,
            schedules: schedules || [],
            vehicles: vehicles || [],
            vehicle_companies: vehicle_companies || [],
            parkings: parkings || []
        },
        message: 'Regra de acesso atualizada com sucesso'
    });

    // Log audit
    await auditService.logUpdate(req, 'access_rule', id, `Atualização de regra de acesso: ${updatedRule.name}`, existingRule, updatedRule);

    // Push: equips afetados = UNION(equips antigos, equips novos).
    // Pessoas/visitantes podem ter ENTRADO ou SAÍDO da lista autorizada de
    // qualquer um deles. Resync força wipe + recreate só dos autorizados.
    try {
        const oldEquips = existingRule.equipments ? JSON.parse(existingRule.equipments) : [];
        const affected = unionEquipmentIds(oldEquips, equipmentsArray);
        await triggerResyncForEquipments(db, tenantId, affected);
    } catch (err) {
        console.error('[rule:update] resync falhou:', err.message);
    }
});

// Excluir (inativar) regra de acesso
export const remove = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const db = await getDb(tenantId);
    
    // Verificar se a regra existe
    const existingRule = await db.get(
        `SELECT * FROM access_rules WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );
    
    if (!existingRule) {
        return res.status(404).json({
            success: false,
            message: 'Regra de acesso não encontrada'
        });
    }
    
    // Inativar ao invés de excluir
    await db.run(
        `UPDATE access_rules SET active = 0, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
        [id, tenantId]
    );

    console.log(`Regra de acesso inativada: ${id} para tenant ${tenantId}`);

    // Invalidar caches LOCAIS + notificar Push (outro processo)
    invalidateCache(tenantId);
    invalidateResolverCache(tenantId);
    notifyPushInvalidateCache(tenantId);

    res.json({
        success: true,
        message: 'Regra de acesso excluída com sucesso'
    });

    // Log audit
    await auditService.logDelete(req, 'access_rule', id, `Exclusão de regra de acesso: ${existingRule.name || id}`, existingRule);

    // Push: regra removida → equipments que ela mencionava precisam resync
    // (pessoas que dependiam SÓ dessa regra somem; outras regras continuam cobrindo).
    try {
        const oldEquips = existingRule.equipments ? JSON.parse(existingRule.equipments) : [];
        await triggerResyncForEquipments(db, tenantId, oldEquips);
    } catch (err) {
        console.error('[rule:remove] resync falhou:', err.message);
    }
});

import { asyncHandler } from '../middleware/errorHandler.js';
import dbManager from '../config/database.js';
import logger from '../config/logger.js';

/**
 * Motor de Cálculo de Faturamento
 * @param {number} qtyPessoas 
 * @param {number} qtyEquip 
 * @param {Array} rules 
 */
function calculateRules(qtyPessoas, qtyEquip, rules) {
    let total = 0;
    const breakdown = [];

    // Processar Pessoas
    const pRules = rules.filter(r => r.entity_type === 'pessoas').sort((a, b) => a.min_quantity - b.min_quantity);
    pRules.forEach(rule => {
        const isBase = rule.is_incremental === 0;
        const matches = qtyPessoas >= rule.min_quantity && (rule.max_quantity === null || qtyPessoas <= rule.max_quantity || isBase);

        // Se for base e bater na faixa OU se for incremental e já passou do mínimo
        if (isBase) {
            if (qtyPessoas >= rule.min_quantity && (rule.max_quantity === null || qtyPessoas <= rule.max_quantity)) {
                total += rule.price;
                breakdown.push({ description: `Base Pessoas (${rule.min_quantity}-${rule.max_quantity || '∞'})`, value: rule.price });
            }
        } else {
            // Incremental: se atingiu o mínimo desta regra, soma o valor
            if (qtyPessoas >= rule.min_quantity) {
                total += rule.price;
                breakdown.push({ description: `Adicional Pessoas (> ${rule.min_quantity-1})`, value: rule.price });
            }
        }
    });

    // Processar Equipamentos
    const eRules = rules.filter(r => r.entity_type === 'equipamentos').sort((a, b) => a.min_quantity - b.min_quantity);
    eRules.forEach(rule => {
        const isBase = rule.is_incremental === 0;
        if (isBase) {
            if (qtyEquip >= rule.min_quantity && (rule.max_quantity === null || qtyEquip <= rule.max_quantity)) {
                total += rule.price;
                breakdown.push({ description: `Base Equipamentos (${rule.min_quantity}-${rule.max_quantity || '∞'})`, value: rule.price });
            }
        } else {
            // Incremental: se atingiu o mínimo desta regra, soma o valor
            if (qtyEquip >= rule.min_quantity) {
                 // Nota: Se a regra for "+R$10 por unidade", o usuário deve cadastrar faixas individuais ou multiplicamos?
                 // O exemplo do usuário diz "2 equipamentos -> R$20... incremental por unidade", 
                 // assumindo regras discretas como 2-2, 3-3 etc.
                total += rule.price;
                breakdown.push({ description: `Adicional Equipamento #${rule.min_quantity}`, value: rule.price });
            }
        }
    });

    return { total, breakdown };
}

/**
 * Gerar Relatório de Faturamento Consolidado
 * GET /api/admin/billing/report?priceTableId=X
 */
export const generateBillingReport = asyncHandler(async (req, res) => {
    const { priceTableId } = req.query;
    if (!priceTableId) return res.status(400).json({ success: false, message: 'ID da tabela de preços é obrigatório' });

    const dbMaster = await dbManager.getConnection('mamcontrolmam');
    try {
        // 1. Buscar as regras da tabela selecionada
        const rules = await dbMaster.all(
            'SELECT * FROM price_ranges WHERE price_table_id = ?',
            [priceTableId]
        );
        const tableInfo = await dbMaster.get('SELECT name FROM price_tables WHERE id = ?', [priceTableId]);

        // 2. Buscar todas as revendas
        const revendas = await dbMaster.all('SELECT id, corporate_name, tenant_id FROM revendas ORDER BY corporate_name');

        const reportData = [];

        // 3. Para cada revenda, consolidar dados dos seus tenants
        for (const revenda of revendas) {
            const tenants = await dbMaster.all(
                'SELECT tenant_id FROM revenda_tenants WHERE revenda_id = ?',
                [revenda.id]
            );

            let totalPessoas = 0;
            let totalEquip = 0;

            for (const t of tenants) {
                try {
                    const dbTenant = await dbManager.getConnection(t.tenant_id);
                    const pCount = await dbTenant.get('SELECT COUNT(*) as count FROM persons WHERE status = "active"');
                    const eCount = await dbTenant.get('SELECT COUNT(*) as count FROM equipments');
                    
                    totalPessoas += pCount?.count || 0;
                    totalEquip += eCount?.count || 0;
                } catch (e) {
                    logger.error(`Erro ao ler dados do tenant ${t.tenant_id}: ${e.message}`);
                }
            }

            // 4. Calcular valor usando o motor
            const { total, breakdown } = calculateRules(totalPessoas, totalEquip, rules);

            reportData.push({
                revenda_name: revenda.corporate_name,
                qty_pessoas: totalPessoas,
                qty_equipamentos: totalEquip,
                breakdown,
                total_to_pay: total
            });
        }

        res.json({
            success: true,
            data: {
                table_name: tableInfo?.name || 'Tabela Desconhecida',
                generated_at: new Date().toISOString(),
                revendas: reportData
            }
        });
    } finally {
        await dbManager.closeConnection('mamcontrolmam');
    }
});

/**
 * Helper para cálculo de estatísticas unificadas
 */

/**
 * Retorna a lista de pessoas/visitantes atualmente no local
 * 
 * Uma pessoa está no local se seu ÚLTIMO registro de acesso do dia 
 * tem action = 'ENTRY' E status = 'SUCCESS'.
 * 
 * @param {Object} db Conexão com o banco de dados do tenant
 * @param {string} date Data no formato YYYY-MM-DD
 */
export async function getPessoasNoLocal(db, date) {
    // Buscar o último status de cada pessoa no dia
    // Filtramos para garantir que apenas acessos com SUCESSO e ENTRADA/SAIDA reais 
    // (não desistências ou negados) sejam considerados para a presença física.
    
    const query = `
        SELECT person_id, person_type, action, created_at
        FROM (
            SELECT al.person_id, al.person_type, al.action, al.created_at,
                   ROW_NUMBER() OVER (PARTITION BY al.person_id ORDER BY al.created_at DESC) as rn
            FROM access_log al
            LEFT JOIN equipments e ON al.equipment_id = e.id
            WHERE DATE(al.created_at) = ?
              AND al.status = 'SUCCESS'
              AND al.person_id IS NOT NULL
              AND al.action IN ('ENTRY', 'EXIT')
              AND (e.controla_estacionamento IS NULL OR e.controla_estacionamento = 0)
        )
        WHERE rn = 1 AND action = 'ENTRY'
    `;

    try {
        const result = await db.all(query, [date]);
        return result || [];
    } catch (error) {
        console.error('Erro ao calcular pessoas no local:', error);
        return [];
    }
}

/**
 * Retorna contagem de veículos no local
 */
export async function getVeiculosNoLocal(db, date) {
    const query = `
        SELECT person_id, action, created_at
        FROM (
            SELECT person_id, action, created_at,
                   ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at DESC) as rn
            FROM access_log
            WHERE DATE(created_at) = ?
              AND status = 'SUCCESS'
              AND person_id IS NOT NULL
              AND person_type = 'vehicle'
              AND action IN ('ENTRY', 'EXIT')
        )
        WHERE rn = 1 AND action = 'ENTRY'
    `;

    try {
        const result = await db.all(query, [date]);
        
        // Complementar com veículos que estão com status 'active' na tabela vehicles
        // (Isso garante que o relatório bata com o controle de vagas do autorizador)
        const activeVehicles = await db.all(`
            SELECT person_id, 'ENTRY' as action, created_at
            FROM vehicles
            WHERE status = 'active'
        `);
        
        // Mesclar resultados (evitar duplicatas)
        const presenceMap = new Map();
        result.forEach(r => presenceMap.set(r.person_id, r));
        activeVehicles.forEach(v => {
            if (!presenceMap.has(v.person_id)) {
                presenceMap.set(v.person_id, v);
            }
        });
        
        return Array.from(presenceMap.values());
    } catch (error) {
        console.error('Erro ao calcular veículos no local:', error);
        return [];
    }
}

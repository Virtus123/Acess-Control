import { asyncHandler } from '../middleware/errorHandler.js';
import { getPessoasNoLocal, getVeiculosNoLocal } from '../utils/statsHelper.js';

/**
 * Controller para o Dashboard
 * Fornece estatísticas e dados paravisualização em tempo real
 */

// Obter estatísticas gerais do dashboard
export const getDashboardStats = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.headers['x-tenant-id'];
  
  try {
    // 1. Total de pessoas cadastradas (ativas)
    const totalPersons = await db.get(
      "SELECT COUNT(*) as count FROM persons WHERE status = 'active'"
    );
    
    // 2. Total de visitantes cadastrados (status on_premises)
    const totalVisitors = await db.get(
      "SELECT COUNT(*) as count FROM visitors WHERE status = 'on_premises'"
    );
     // 3. Pessoas/Visitantes no local - USANDO HELPER UNIFICADO
    const today = new Date().toISOString().split('T')[0];
    const pessoasNoLocal = await getPessoasNoLocal(db, today);
    
    const countPessoas = pessoasNoLocal.filter(p => p.person_type === 'person' || p.person_type === 'pessoa').length;
    const countVisitantes = pessoasNoLocal.filter(p => p.person_type === 'visitor' || p.person_type === 'visitante').length;
    
    // 5. Veículos no local - USANDO HELPER UNIFICADO
    const veiculosNoLocal = await getVeiculosNoLocal(db, today);
    const countVeiculos = veiculosNoLocal.length;
    
    // 6. Novas pessoas este mês
    const newPersonsThisMonth = await db.get(`
      SELECT COUNT(*) as count 
      FROM persons 
      WHERE status = 'active' 
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);
    
    // 7. Entradas de pessoas hoje - excluir equipamentos de estacionamento
    const entriesPersonsToday = await db.get(`
      SELECT COUNT(*) as count
      FROM access_log al
      LEFT JOIN equipments e ON al.equipment_id = e.id
      WHERE al.person_type = 'person'
        AND al.action = 'ENTRY'
        AND al.status = 'SUCCESS'
        AND date(al.created_at) = date('now')
        AND (e.controla_estacionamento IS NULL OR e.controla_estacionamento = 0)
    `);

    // 8. Entradas de visitantes hoje - excluir equipamentos de estacionamento
    const entriesVisitorsToday = await db.get(`
      SELECT COUNT(*) as count
      FROM access_log al
      LEFT JOIN equipments e ON al.equipment_id = e.id
      WHERE al.person_type = 'visitor'
        AND al.action = 'ENTRY'
        AND al.status = 'SUCCESS'
        AND date(al.created_at) = date('now')
        AND (e.controla_estacionamento IS NULL OR e.controla_estacionamento = 0)
    `);
    
    // 9. Entradas de veículos hoje - filtrar apenas equipamentos de estacionamento
    const entriesVehiclesToday = await db.get(`
      SELECT COUNT(*) as count 
      FROM access_log al
      LEFT JOIN equipments e ON al.equipment_id = e.id
      WHERE al.person_type = 'vehicle'
        AND al.action = 'ENTRY' 
        AND al.status = 'SUCCESS'
        AND date(al.created_at) = date('now')
        AND (al.access_type = 'VEHICLE' OR e.controla_estacionamento = 1 OR e.controla_estacionamento = true)
    `);
    
    res.json({
      success: true,
      data: {
        pessoasCadastradas: totalPersons?.count || 0,
        visitantesCadastrados: totalVisitors?.count || 0,
        pessoasNoLocal: countPessoas,
        visitantesNoLocal: countVisitantes,
        veiculosNoLocal: countVeiculos,
        novosPessoas: newPersonsThisMonth?.count || 0,
        entradasPessoasHoje: entriesPersonsToday?.count || 0,
        entradasVisitantesHoje: entriesVisitorsToday?.count || 0,
        entradasVeiculosHoje: entriesVehiclesToday?.count || 0
      }
    });
  } catch (error) {
    console.error('[Dashboard] Erro ao buscar estatísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar estatísticas do dashboard',
      error: error.message
    });
  }
});

// Obter dados para gráficos de acessos semanais
export const getWeeklyAccessData = asyncHandler(async (req, res) => {
  const db = req.db;
  
  try {
    // Obter dados dos últimos 7 dias para pessoas
    const personData = await db.all(`
      SELECT 
        strftime('%w', created_at) as dia_semana,
        COUNT(*) as total
      FROM access_log 
      WHERE person_type = 'person' 
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-7 days')
      GROUP BY strftime('%w', created_at)
      ORDER BY dia_semana
    `);
    
    // Obter dados dos últimos 7 dias para visitantes
    const visitorData = await db.all(`
      SELECT 
        strftime('%w', created_at) as dia_semana,
        COUNT(*) as total
      FROM access_log 
      WHERE person_type = 'visitor' 
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-7 days')
      GROUP BY strftime('%w', created_at)
      ORDER BY dia_semana
    `);
    
    // Obter dados dos últimos 7 dias para veículos
    const vehicleData = await db.all(`
      SELECT 
        strftime('%w', created_at) as dia_semana,
        COUNT(*) as total
      FROM access_log 
      WHERE person_type = 'vehicle'
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-7 days')
      GROUP BY strftime('%w', created_at)
      ORDER BY dia_semana
    `);
    
    // Processar dados para os gráficos (preencher dias sem dados com 0)
    const diasSemana = ['0', '1', '2', '3', '4', '5', '6'];
    const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    
    // Converter dados de pessoas
    const acessosPessoas = diasSemana.map(dia => {
      const dado = personData.find(d => d.dia_semana === dia);
      return dado ? dado.total : 0;
    });
    
    // Converter dados de visitantes
    const acessosVisitantes = diasSemana.map(dia => {
      const dado = visitorData.find(d => d.dia_semana === dia);
      return dado ? dado.total : 0;
    });
    
    // Converter dados de veículos
    const acessosVeiculos = diasSemana.map(dia => {
      const dado = vehicleData.find(d => d.dia_semana === dia);
      return dado ? dado.total : 0;
    });
    
    // Calcular percentual de mudança (comparando esta semana com semana anterior)
    const thisWeekVisitors = await db.get(`
      SELECT COUNT(*) as count 
      FROM access_log 
      WHERE person_type = 'visitor' 
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-7 days')
    `);
    
    const lastWeekVisitors = await db.get(`
      SELECT COUNT(*) as count 
      FROM access_log 
      WHERE person_type = 'visitor' 
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-14 days')
        AND created_at < date('now', '-7 days')
    `);
    
    let percentualVisitantes = 0;
    if (lastWeekVisitors?.count > 0) {
      percentualVisitantes = Math.round(
        ((thisWeekVisitors?.count || 0) - lastWeekVisitors.count) / lastWeekVisitors.count * 100
      );
    }
    
    const thisWeekVehicles = await db.get(`
      SELECT COUNT(*) as count 
      FROM access_log 
      WHERE person_type = 'vehicle'
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-7 days')
    `);
    
    const lastWeekVehicles = await db.get(`
      SELECT COUNT(*) as count 
      FROM access_log 
      WHERE person_type = 'vehicle'
        AND action = 'ENTRY' 
        AND status = 'SUCCESS'
        AND created_at >= date('now', '-14 days')
        AND created_at < date('now', '-7 days')
    `);
    
    let percentualVeiculos = 0;
    if (lastWeekVehicles?.count > 0) {
      percentualVeiculos = Math.round(
        ((thisWeekVehicles?.count || 0) - lastWeekVehicles.count) / lastWeekVehicles.count * 100
      );
    }
    
    res.json({
      success: true,
      data: {
        labels,
        acessosPessoas,
        acessosVisitantes,
        acessosVeiculos,
        percentualVisitantes: percentualVisitantes > 0 ? `+${percentualVisitantes}%` : `${percentualVisitantes}%`,
        percentualVeiculos: percentualVeiculos > 0 ? `+${percentualVeiculos}%` : `${percentualVeiculos}%`
      }
    });
  } catch (error) {
    console.error('[Dashboard] Erro ao buscar dados de acessos:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar dados de acessos',
      error: error.message
    });
  }
});

// Obter atividades recentes
export const getRecentActivities = asyncHandler(async (req, res) => {
  const db = req.db;
  
  try {
    const activities = await db.all(`
      SELECT
        al.id,
        al.person_id,
        al.person_type,
        al.action,
        al.status,
        al.message,
        al.plate,
        al.created_at,
        CASE
          WHEN al.person_type = 'person'  THEN p.name
          WHEN al.person_type = 'visitor' THEN v.name
          WHEN al.person_type = 'vehicle' THEN p.name
        END as person_name
      FROM access_log al
      LEFT JOIN persons p ON al.person_id = p.id
      LEFT JOIN visitors v ON al.person_type = 'visitor' AND al.person_id = v.id
      WHERE al.status = 'SUCCESS'
      ORDER BY al.created_at DESC
      LIMIT 10
    `);
    
    // Formatar atividades
    const formattedActivities = activities.map(activity => {
      let iconClass = 'fa-user';
      let iconColor = 'info';

      if (activity.person_type === 'vehicle') {
        iconClass = activity.action === 'ENTRY' ? 'fa-car' : 'fa-car';
        iconColor = activity.action === 'ENTRY' ? 'success' : 'purple';
        const owner = activity.person_name ? ` (${activity.person_name})` : '';
        return {
          id: activity.id,
          icon: iconColor,
          iconClass,
          texto: `${activity.plate || 'Veículo'}${owner} ${activity.action === 'ENTRY' ? 'entrou' : 'saiu'}`,
          tempo: formatTimeAgo(activity.created_at)
        };
      }

      if (activity.person_type === 'visitor') {
        iconClass = 'fa-user-friends';
        iconColor = 'warning';
      }

      if (activity.action === 'ENTRY') {
        iconClass = activity.person_type === 'person' ? 'fa-user-plus' : 'fa-sign-in-alt';
        iconColor = 'success';
      } else if (activity.action === 'EXIT') {
        iconClass = 'fa-sign-out-alt';
        iconColor = 'purple';
      }

      const actionText = activity.action === 'ENTRY' ? 'entrou' : 'saiu';

      return {
        id: activity.id,
        icon: iconColor,
        iconClass,
        texto: `${activity.person_name || 'Usuário'} ${actionText}`,
        tempo: formatTimeAgo(activity.created_at)
      };
    });
    
    res.json({
      success: true,
      data: formattedActivities
    });
  } catch (error) {
    console.error('[Dashboard] Erro ao buscar atividades:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao buscar atividades',
      error: error.message
    });
  }
});

// Função auxiliar para formatar tempo relativo
function formatTimeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Agora mesmo';
  if (diffMins < 60) return `${diffMins} minuto${diffMins > 1 ? 's' : ''} atrás`;
  if (diffHours < 24) return `${diffHours} hora${diffHours > 1 ? 's' : ''} atrás`;
  if (diffDays < 7) return `${diffDays} dia${diffDays > 1 ? 's' : ''} atrás`;
  return date.toLocaleDateString('pt-BR');
}

export default {
  getDashboardStats,
  getWeeklyAccessData,
  getRecentActivities
};

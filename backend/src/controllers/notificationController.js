import globalDb from '../config/globalDatabase.js';

/**
 * Controller para gerenciar notificações globais
 * Estas notificações aparecem em todos os tenants
 */

// Listar todas as notificações ativas (para todos os usuários)
export const listNotifications = async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || req.headers['x-tenant-id'] || 'default';
    
    const notifications = await globalDb.all(`
      SELECT n.*, 
        CASE WHEN r.notification_id IS NOT NULL THEN 1 ELSE 0 END as is_read
      FROM global_notifications n
      LEFT JOIN notification_reads r ON n.id = r.notification_id AND r.tenant_id = ?
      WHERE n.is_active = 1 
      AND (n.expires_at IS NULL OR n.expires_at > datetime('now'))
      ORDER BY n.is_prioritary DESC, n.created_at DESC
    `, [tenantId]);
    
    res.json(notifications);
  } catch (error) {
    console.error('Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro ao listar notificações' });
  }
};

// Listar notificações prioritárias não lidas (para auto-abrir no login)
export const listUnreadPrioritary = async (req, res) => {
  try {
    // Obter tenant_id do request (definido pelo middleware de autenticação)
    const tenantId = req.query.tenant_id || req.headers['x-tenant-id'] || 'default';
    
    console.log('[Notifications] listUnreadPrioritary - Tenant:', tenantId);
    
    const notifications = await globalDb.all(`
      SELECT n.* FROM global_notifications n
      WHERE n.is_active = 1 
      AND n.is_prioritary = 1
      AND (n.expires_at IS NULL OR n.expires_at > datetime('now'))
      AND NOT EXISTS (
        SELECT 1 FROM notification_reads r 
        WHERE r.notification_id = n.id AND r.tenant_id = ?
      )
      ORDER BY n.created_at DESC
    `, [tenantId]);
    
    console.log('[Notifications] Notificações encontradas:', notifications.length);
    
    res.json(notifications);
  } catch (error) {
    console.error('Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro ao listar notificações' });
  }
};

// Listar todas as notificações (para admin master)
export const listAllNotifications = async (req, res) => {
  try {
    const notifications = await globalDb.all(`
      SELECT * FROM global_notifications 
      ORDER BY is_prioritary DESC, created_at DESC
    `);
    
    res.json(notifications);
  } catch (error) {
    console.error('Erro ao listar notificações:', error);
    res.status(500).json({ error: 'Erro ao listar notificações' });
  }
};

// Criar nova notificação
export const createNotification = async (req, res) => {
  try {
    const { title, message, expires_at, is_prioritary } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ error: 'Título e mensagem são obrigatórios' });
    }
    
    const result = await globalDb.run(
      `INSERT INTO global_notifications (title, message, expires_at, is_prioritary, created_by) VALUES (?, ?, ?, ?, ?)`,
      [title, message, expires_at || null, is_prioritary ? 1 : 0, 'Admin Master']
    );
    
    res.status(201).json({
      id: result.lastID,
      title,
      message,
      expires_at,
      is_prioritary: is_prioritary ? 1 : 0,
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro ao criar notificação:', error);
    res.status(500).json({ error: 'Erro ao criar notificação' });
  }
};

// Atualizar notificação
export const updateNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, message, is_active, expires_at, is_prioritary } = req.body;
    
    const updates = [];
    const params = [];
    
    if (title) {
      updates.push('title = ?');
      params.push(title);
    }
    if (message) {
      updates.push('message = ?');
      params.push(message);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      params.push(is_active);
    }
    if (is_prioritary !== undefined) {
      updates.push('is_prioritary = ?');
      params.push(is_prioritary);
    }
    if (expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(expires_at);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    
    params.push(id);
    
    const result = await globalDb.run(
      `UPDATE global_notifications SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Notificação não encontrada' });
    }
    
    res.json({ message: 'Notificação atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar notificação:', error);
    res.status(500).json({ error: 'Erro ao atualizar notificação' });
  }
};

// Deletar notificação
export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await globalDb.run(
      `DELETE FROM global_notifications WHERE id = ?`,
      [id]
    );
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Notificação não encontrada' });
    }
    
    res.json({ message: 'Notificação deletada com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar notificação:', error);
    res.status(500).json({ error: 'Erro ao deletar notificação' });
  }
};

// Marcar notificação como lida
export const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.body.tenant_id || req.headers['x-tenant-id'] || 'default';
    
    console.log('[Notifications] Marcando como lida - ID:', id, 'Tenant:', tenantId);
    
    // Registrar a leitura no banco de dados por tenant
    const result = await globalDb.run(
      `INSERT OR IGNORE INTO notification_reads (notification_id, tenant_id) VALUES (?, ?)`,
      [id, tenantId]
    );
    
    console.log('[Notifications] Resultado:', result);
    
    res.json({ message: 'Notificação marcada como lida' });
  } catch (error) {
    console.error('Erro ao marcar notificação como lida:', error);
    res.status(500).json({ error: 'Erro ao marcar notificação como lida' });
  }
};

// Contar notificações ativas (para o badge)
export const countNotifications = async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || req.headers['x-tenant-id'] || 'default';
    
    const result = await globalDb.get(`
      SELECT COUNT(*) as count FROM global_notifications n
      WHERE n.is_active = 1 
      AND (n.expires_at IS NULL OR n.expires_at > datetime('now'))
      AND NOT EXISTS (
        SELECT 1 FROM notification_reads r 
        WHERE r.notification_id = n.id AND r.tenant_id = ?
      )
    `, [tenantId]);
    
    res.json({ count: result.count });
  } catch (error) {
    console.error('Erro ao contar notificações:', error);
    res.status(500).json({ error: 'Erro ao contar notificações' });
  }
};

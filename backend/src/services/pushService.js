/**
 * Push Notification Service
 * Envia notificações via Expo Push API para dispositivos registrados.
 * Filtra por tenant_id para garantir isolamento multi-tenant.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Envia push notification para dispositivos específicos
 * @param {Array<string>} tokens - Expo push tokens
 * @param {string} title - Título da notificação
 * @param {string} body - Corpo da notificação
 * @param {object} data - Dados extras (navegação, etc.)
 * @param {string} channelId - Canal Android (default, encomendas, acessos)
 */
async function sendPush(tokens, title, body, data = {}, channelId = 'default') {
  if (!tokens || tokens.length === 0) return;

  const messages = tokens
    .filter(token => token && token.startsWith('ExponentPushToken'))
    .map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      channelId,
    }));

  if (messages.length === 0) return;

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json();

    // Log erros de tokens inválidos para limpeza futura
    if (result.data) {
      result.data.forEach((ticket, i) => {
        if (ticket.status === 'error') {
          console.warn(`[PUSH] Token inválido: ${messages[i].to} - ${ticket.message}`);
        }
      });
    }

    return result;
  } catch (error) {
    console.error('[PUSH] Erro ao enviar notificação:', error.message);
  }
}

/**
 * Notifica dispositivos quando uma encomenda é criada.
 * Envia APENAS para dispositivos do mesmo tenant, filtrando por:
 * - destinatario_pessoa_id (pessoa específica)
 * - destinatario_company_id (empresa vinculada)
 * Se nenhum dos dois for informado, não envia push (evita spam).
 */
async function notifyNewEncomenda(db, tenantId, encomenda) {
  try {
    // Garantir que a tabela existe
    const tableCheck = await db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='push_devices'"
    );
    if (!tableCheck) return;

    let tokens = [];

    if (encomenda.pessoaId) {
      // Notificar dispositivo da pessoa específica (destinatário direto)
      const devices = await db.all(
        'SELECT push_token FROM push_devices WHERE tenant_id = ? AND user_id = ?',
        [tenantId, encomenda.pessoaId]
      );
      tokens = devices.map(d => d.push_token);
    } else if (encomenda.companyId) {
      // Notificar todos os dispositivos vinculados à empresa no mesmo tenant
      const devices = await db.all(
        'SELECT push_token FROM push_devices WHERE tenant_id = ? AND company_id = ?',
        [tenantId, encomenda.companyId]
      );
      tokens = devices.map(d => d.push_token);
    }

    if (tokens.length === 0) return;

    const title = '📦 Nova Encomenda';
    const body = encomenda.destinatario
      ? `Encomenda para ${encomenda.destinatario} - ${encomenda.tipo || 'Pacote'}`
      : `Nova encomenda registrada - ${encomenda.tipo || 'Pacote'}`;

    await sendPush(
      tokens,
      title,
      body,
      { type: 'encomenda', encomendaId: encomenda.id },
      'encomendas'
    );

    console.log(`[PUSH] Encomenda ${encomenda.id}: notificou ${tokens.length} dispositivo(s) no tenant ${tenantId}`);
  } catch (error) {
    console.error('[PUSH] Erro ao notificar encomenda:', error.message);
  }
}

export default { sendPush, notifyNewEncomenda };

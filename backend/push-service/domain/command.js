// Entidade Command — comando a ser enviado ao equipamento via Push.
// Sem I/O, sem framework. Apenas validação e factory.

export const VALID_VERBS = ['GET', 'POST', 'PUT', 'DELETE'];

export class Command {
  constructor({ endpoint, verb = 'POST', body = null, queryString = null,
                contentType = 'application/json', deviceId, batchId = null,
                batchOrder = 0, origin = null,
                sourceTaskId = null, sourceSyncId = null }) {
    if (!endpoint) throw new Error('Command: endpoint obrigatório');
    if (!deviceId) throw new Error('Command: deviceId obrigatório');
    if (!VALID_VERBS.includes(verb)) {
      throw new Error(`Command: verb inválido: ${verb}`);
    }

    this.endpoint = endpoint;
    this.verb = verb;
    this.body = body;
    this.queryString = queryString;
    this.contentType = contentType;
    this.deviceId = String(deviceId);
    this.batchId = batchId;
    this.batchOrder = batchOrder;
    this.origin = origin;
    this.sourceTaskId = sourceTaskId;
    this.sourceSyncId = sourceSyncId;
  }

  // Converte para o JSON que vai na resposta do /push (comando único).
  toPushPayload() {
    const payload = {
      verb: this.verb,
      endpoint: this.endpoint,
      contentType: this.contentType,
    };
    if (this.body !== null && this.body !== undefined) payload.body = this.body;
    if (this.queryString) payload.queryString = this.queryString;
    return payload;
  }

  // Converte para item de transaction (quando faz parte de batch).
  toTransactionItem(transactionId) {
    return {
      transactionid: String(transactionId),
      ...this.toPushPayload(),
    };
  }

  // Reconstrói Command a partir de linha do banco (push_outbox).
  static fromRow(row) {
    let body = row.body;
    if (body && row.content_type === 'application/json') {
      try { body = JSON.parse(body); } catch { /* mantém como string */ }
    }
    return new Command({
      endpoint: row.endpoint,
      verb: row.verb,
      body,
      queryString: row.query_string,
      contentType: row.content_type,
      deviceId: row.device_id,
      batchId: row.batch_id,
      batchOrder: row.batch_order,
      origin: row.origin,
      sourceTaskId: row.source_task_id,
      sourceSyncId: row.source_sync_id,
    });
  }
}

// Constrói payload de resposta apropriado: comando único ou transactions.
export function buildPushResponse(commands) {
  if (!commands || commands.length === 0) return null;

  if (commands.length === 1 && !commands[0].batchId) {
    return commands[0].toPushPayload();
  }

  return {
    transactions: commands.map((c, idx) => c.toTransactionItem(idx + 1)),
  };
}

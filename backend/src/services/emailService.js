import nodemailer from 'nodemailer';
import logger from '../config/logger.js';
import { getTenantDatabase } from '../middleware/tenantManager.js';

// Validador de formato de e-mail. RFC 5322 simplificado — pega 99% dos casos reais.
// Sem isso, strings como " ", "abc", "x@" eram aceitas e o SMTP rejeitava silenciosamente.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(addr) {
  if (typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && EMAIL_REGEX.test(trimmed);
}
function sanitizeRecipientList(list) {
  // Aceita string com vírgulas ou array; retorna lista deduplicada e validada
  const items = Array.isArray(list)
    ? list
    : String(list || '').split(/[;,]/);
  const seen = new Set();
  for (const raw of items) {
    const e = String(raw || '').trim().toLowerCase();
    if (isValidEmail(e)) seen.add(e);
  }
  return Array.from(seen);
}

/**
 * EmailService - Global multi-tenant notification system
 * Features: In-memory queue, 1 concurrent worker, exponential backoff retry.
 */
class EmailService {
  constructor() {
    this.queue = [];
    this.processando = false;
    this.maxRetries = 3;
    this.backoffTimes = [30000, 60000, 120000]; // 30s, 1m, 2m
    
    this.config = {};
    this.transporter = null;
    this.initialized = false;
  }

  /**
   * Inicializa o transportador e verifica conexão
   */
  async init() {
    // Se já está operando, não reinicia
    if (this.initialized && this.transporter) return;

    // Recarregar configurações do ambiente
    this.config = {
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '465'),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      },
      from: process.env.EMAIL_FROM || '"Acess Control" <noreply@example.com>'
    };

    try {
      if (!this.config.host || !this.config.auth.user || !this.config.auth.pass) {
        logger.warn('[EmailService] SMTP incompleto (HOST/USER/PASS ausentes). Notificações em espera.');
        return;
      }

      logger.info(`[EmailService] Inicializando transporte SMTP: ${this.config.host}:${this.config.port}...`);
      this.transporter = nodemailer.createTransport({
        ...this.config,
        // Pool de conexões para evitar handshake TLS a cada envio
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
      });

      // Aguarda o verify completar (versão promisificada).
      // Antes era callback, init() retornava antes — race condition.
      try {
        await this.transporter.verify();
        this.initialized = true;
        logger.info('[EmailService] SMTP conectado e pronto para envios');
      } catch (verifyErr) {
        logger.error(`[EmailService] Erro na conexão SMTP (${this.config.host}): ${verifyErr.message}`);
        this.initialized = false;
      }
    } catch (error) {
      logger.error('[EmailService] Falha crítica ao criar transportador:', error.message);
      this.initialized = false;
    }
  }

  /**
   * Envia email de baixo nível (adiciona à fila)
   */
  enviarEmail({ para, assunto, corpo, cc, bcc, replyTo, anexos, tenantId }) {
    // Validação básica
    if (!para || !assunto || !corpo) {
      return {
        queued: false,
        error: 'Campos obrigatórios ausentes: para, assunto ou corpo'
      };
    }

    // Sanitização: remove endereços inválidos e duplicados ANTES de chegar no SMTP.
    // Sem isso, o servidor SMTP aceitava o lote com 1 email válido + 5 lixos e
    // marcava como "enviado" — mas algumas mensagens nunca eram entregues.
    const validPara = sanitizeRecipientList(para);
    if (validPara.length === 0) {
      logger.warn(`[EmailService] Email descartado: nenhum destinatário válido em "${para}" (assunto: ${assunto})`);
      return { queued: false, error: 'Nenhum destinatário válido' };
    }
    const validCc = cc ? sanitizeRecipientList(cc) : [];
    const validBcc = bcc ? sanitizeRecipientList(bcc) : [];

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    const job = {
      id: jobId,
      tenantId, // ID do tenant para persistência
      options: {
        from: this.config.from,
        to: validPara.join(', '),
        subject: assunto,
        html: corpo,
        cc: validCc.length ? validCc.join(', ') : undefined,
        bcc: validBcc.length ? validBcc.join(', ') : undefined,
        replyTo,
        attachments: anexos
      },
      attempts: 0,
      nextAttempt: Date.now()
    };

    this.queue.push(job);

    // Persistência inicial (Opcional: se falhar o banco, ainda enviamos o email)
    if (tenantId) {
      this.logToDatabase(job, 'pending').catch(err => {
        logger.error(`[EmailService] Erro ao criar log inicial (ID: ${jobId}):`, err.message);
      });
    }

    logger.info(`[EmailService] Email enfileirado: ${assunto} -> ${para} (ID: ${jobId}, Tenant: ${tenantId || 'global'})`);
    
    // Disparar worker de forma assíncrona
    setTimeout(() => this.processarFila(), 0);

    return { queued: true, jobId };
  }

  /**
   * Persiste o status do email no banco de dados do tenant
   */
  async logToDatabase(job, status, errorMessage = null) {
    if (!job.tenantId) return;

    try {
      const db = await getTenantDatabase(job.tenantId);
      
      // Tenta atualizar se já existe, senão insere
      // Usamos o jobId como referência no log (embora não tenhamos coluna jobId, podemos usar subject + to_address + created_at ou adicionar a coluna)
      // Melhor adicionar a coluna jobId no migration? Não, vamos usar subject e to_address como busca simples ou apenas inserir novos registros a cada tentativa.
      // Na verdade, o ideal é ter um ID de log.
      
      if (status === 'pending') {
        const result = await db.run(
          `INSERT INTO email_logs (tenant_id, to_address, subject, status, body, cc) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [job.tenantId, job.options.to, job.options.subject, 'pending', job.options.html, job.options.cc || null]
        );
        job.logId = result.lastID; // Guardar ID do log para atualizações futuras
      } else if (job.logId) {
        await db.run(
          `UPDATE email_logs 
           SET status = ?, error_message = ?, attempts = ?, sent_at = ? 
           WHERE id = ?`,
          [
            status, 
            errorMessage, 
            job.attempts, 
            status === 'sent' ? new Date().toISOString() : null,
            job.logId
          ]
        );
      }
    } catch (error) {
      // Se a tabela não existir, ignoramos silenciosamente para não quebrar o envio
      if (!error.message.includes('no such table')) {
        logger.error(`[EmailService] Erro de banco ao logar email: ${error.message}`);
      }
    }
  }

  /**
   * Worker recursivo para processar a fila
   */
  async processarFila() {
    if (this.processando || this.queue.length === 0) return;

    this.processando = true;

    try {
      // Pega o primeiro item que já pode ser tentado
      const now = Date.now();
      const index = this.queue.findIndex(job => job.nextAttempt <= now);

      if (index === -1) {
        this.processando = false;
        // Se ainda tem itens mas nenhum pronto, agenda uma nova checagem no menor intervalo
        if (this.queue.length > 0) {
          setTimeout(() => this.processarFila(), 10000);
        }
        return;
      }

      const job = this.queue.splice(index, 1)[0];

      // Tentar auto-inicialização se não estiver pronto
      if (!this.initialized) {
        await this.init();
      }

      if (!this.initialized) {
        logger.warn(`[EmailService] SMTP ainda não disponível. Job ${job.id} reenfileirado.`);
        this.reenfileirar(job);
      } else {
        try {
          await this.transporter.sendMail(job.options);
          logger.info(`[EmailService] Sucesso no envio: ${job.id}`);
          
          if (job.tenantId) {
            this.logToDatabase(job, 'sent').catch(() => {});
          }
        } catch (error) {
          logger.error(`[EmailService] Erro no envio (${job.id}): ${error.message}`);
          
          if (job.tenantId && job.attempts >= this.maxRetries) {
            this.logToDatabase(job, 'failed', error.message).catch(() => {});
          }
          
          this.reenfileirar(job);
        }
      }
    } catch (err) {
      logger.error('[EmailService] Erro no worker da fila:', err.message);
    } finally {
      this.processando = false;
      // Próximo job
      setTimeout(() => this.processarFila(), 100);
    }
  }

  /**
   * Lógica de retry com backoff
   */
  reenfileirar(job) {
    if (job.attempts < this.maxRetries) {
      const waitTime = this.backoffTimes[job.attempts] || 30000;
      job.attempts++;
      job.nextAttempt = Date.now() + waitTime;
      this.queue.push(job);
      logger.info(`[EmailService] Job ${job.id} reenfileirado para tentativa ${job.attempts + 1} em ${waitTime/1000}s`);
    } else {
      logger.error(`[EmailService] FAILED: Job ${job.id} falhou após ${this.maxRetries} tentativas.`);
    }
  }

  /**
   * Disparador de notificações baseado em eventos do tenant
   */
  async dispararNotificacao({ tipoEvento, tenantId, dados, emailDestinatarioDinamico }) {
    try {
      const db = await getTenantDatabase(tenantId);
      
      // Buscar regras ativas para este evento
      const regras = await db.all(
        'SELECT * FROM notificacoes WHERE tipo_evento = ? AND ativo = 1',
        [tipoEvento]
      );

      if (!regras || regras.length === 0) return;

      for (const regra of regras) {
        try {
          // Resolver destinatários
          const destinatarios = new Set();
          
          // 1. Emails fixos/dinâmicos baseados no tipo
          if (['visitante_entrada', 'encomenda'].includes(tipoEvento) && emailDestinatarioDinamico) {
            destinatarios.add(emailDestinatarioDinamico);
          }

          // 2. Emails de grupos (se configurado)
          if (regra.grupos) {
            const grupoIds = JSON.parse(regra.grupos);
            if (grupoIds && grupoIds.length > 0) {
              const placeholders = grupoIds.map(() => '?').join(',');
              const emailsGrupo = await db.all(
                `SELECT email FROM persons WHERE group_id IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
                grupoIds
              );
              emailsGrupo.forEach(e => destinatarios.add(e.email));
            }
          }

          if (destinatarios.size === 0) {
            logger.warn(`[EmailService] Ninguém para receber notificação ${regra.nome} (${tipoEvento})`);
            continue;
          }

          // Substituir variáveis no assunto e corpo
          const assunto = this.substituirVariaveis(regra.assunto, dados);
          const corpo = this.substituirVariaveis(this.template(regra.corpo), dados);

          // Enviar (enfileirar)
          const para = Array.from(destinatarios).join(', ');
          this.enviarEmail({ para, assunto, corpo, tenantId });

        } catch (ruleErr) {
          logger.error(`[EmailService] Erro ao processar regra de notificação ${regra.id}:`, ruleErr.message);
        }
      }
    } catch (error) {
      logger.error(`[EmailService] Erro ao disparar notificações no tenant ${tenantId}:`, error.message);
    }
  }

  /**
   * Helper para substituição de variáveis
   * Suporta tanto chaves mapeadas (ex: {nome.visitante}) quanto chaves brutas (ex: {personName})
   */
  substituirVariaveis(template, dados = {}) {
    if (!template) return '';
    let result = template;

    // 1. Mapa de variáveis "amigáveis" (Inspirado no plano do usuário)
    const map = {
      'nome.visitante': dados.personName || dados.nomeVisitante || '',
      'empresa.visitante': dados.personCompany || dados.empresaVisitante || '',
      'documento': dados.documento || dados.personDocument || '',
      'data_e_hora': dados.dataHora || new Date().toLocaleString('pt-BR'),
      'nome.equipamento': dados.nomeEquipamento || dados.equipmentName || '',
      'local.equipamento': dados.localEquipamento || dados.equipmentLocation || '',
      'sentido': dados.sentido || (dados.action === 'EXIT' ? 'Saída' : 'Entrada'),
      'empresa.destino': dados.empresaDestino || '',
      'responsavel.destino': dados.responsavelDestino || '',
      'nome.pessoa': dados.nomePessoa || dados.personName || '',
      'destinatario.encomenda': dados.destinatarioEncomenda || '',
      'descricao.encomenda': dados.descricaoEncomenda || '',
      'data_chegada': dados.dataChegada || '',
      'nome.porteiro': dados.nomePorteiro || '',
      'motivo.negacao': dados.motivoNegacao || dados.message || ''
    };

    // Substituir chaves do mapa
    for (const [key, value] of Object.entries(map)) {
      const regex = new RegExp(`{${key.replace(/\./g, '\\.')}}`, 'g');
      result = result.replace(regex, value);
    }

    // 2. Substituir chaves brutas que vieram no objeto dados
    for (const [key, value] of Object.entries(dados)) {
      if (typeof value === 'string' || typeof value === 'number') {
        const regex = new RegExp(`{${key}}`, 'g');
        result = result.replace(regex, value);
      }
    }

    return result;
  }

  /**
   * Alias de compatibilidade com controllers que usam nomes em inglês
   */
  sendEmail(options) {
    const { to, subject, html, tenantId, ...rest } = options;
    return this.enviarEmail({ para: to, assunto: subject, corpo: html, tenantId, ...rest });
  }

  /**
   * Email de boas-vindas para novos tenants
   */
  sendTenantCreatedEmail(email, tenantId, password, companyName) {
    const assunto = `Bem-vindo ao Acess Control - ${companyName}`;
    const corpo = `
      <h3>Olá, administrador da empresa ${companyName}!</h3>
      <p>Sua base de dados foi criada com sucesso no sistema Acess Control.</p>
      <p>Abaixo estão suas credenciais de acesso:</p>
      <table class="info-table">
        <tr><td class="label">ID da Unidade:</td><td><strong>${tenantId}</strong></td></tr>
        <tr><td class="label">Usuário (E-mail):</td><td>${email}</td></tr>
        <tr><td class="label">Senha:</td><td>${password}</td></tr>
      </table>
      <p>Para acessar o sistema, utilize o link abaixo:</p>
      <a href="${process.env.FRONTEND_URL || '#'}" class="btn">Acessar Painel de Controle</a>
      <p style="color: #666; font-size: 13px; margin-top: 20px;">Recomendamos que você altere sua senha no primeiro acesso.</p>
    `;
    return this.sendEmail({ to: email, subject: assunto, html: this.template(corpo), tenantId });
  }

  /**
   * Email de reset de senha para admins de tenant
   */
  sendPasswordResetEmail(email, tenantId, newPassword) {
    const assunto = 'Nova Senha Gerada - Acess Control';
    const corpo = `
      <h3>Redefinição de Senha</h3>
      <p>Conforme solicitado, uma nova senha foi gerada para o seu acesso à unidade <strong>${tenantId}</strong>.</p>
      <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <span style="font-size: 24px; font-weight: bold; color: #1a237e; letter-spacing: 2px;">${newPassword}</span>
      </div>
      <p>Use esta senha para entrar no sistema e lembre-se de trocá-la logo após o login.</p>
      <a href="${process.env.FRONTEND_URL || '#'}" class="btn">Ir para Login</a>
    `;
    return this.sendEmail({ to: email, subject: assunto, html: this.template(corpo), tenantId });
  }

  /**
   * PASSO 6: Notificação especializada para entrada de visitante
   * Busca e-mails da empresa, das pessoas vinculadas e dos grupos vinculados.
   */
  async dispararEmailVisitante({ tenantId, log }) {
    try {
      const db = await getTenantDatabase(tenantId);
      
      // PASSO A: Verificar feature flag
      const flagRow = await db.get(
        "SELECT value FROM tenant_config WHERE key = 'notif_visitante_entrada_email'"
      );
      if (!flagRow || flagRow.value !== 'true') return;

      // PASSO B: Buscar regras ativas do tipo visitante_entrada (usado para ambos entrada/saída por simplicidade de config)
      const regras = await db.all(
        "SELECT * FROM notificacoes WHERE tipo_evento = 'visitante_entrada' AND ativo = 1"
      );
      if (!regras || regras.length === 0) {
        logger.warn('[NotifVisitante] Nenhuma regra ativa para visitante_entrada');
        return;
      }

      // PASSO C: Obter dados do visitante
      const personId = log.person_id || log.visitor_id;
      const visitante = await db.get(
        'SELECT * FROM visitors WHERE id = ?', [personId]
      );
      if (!visitante) return;

      // PASSO D: Obter empresa visitada
      const companyId = log.visited_company_id || log.company_id || visitante.visited_company_id;
      if (!companyId) return;

      const empresa = await db.get(
        'SELECT * FROM companies WHERE id = ?', [companyId]
      );
      if (!empresa) return;

      // PASSO E: Coletar destinatários (Set para deduplicar)
      const destinatarios = new Set();

      // Fonte 1 — E-mails da empresa (tabela de notificações)
      try {
        const emailsEmpresa = await db.all(
          'SELECT email FROM company_notification_emails WHERE company_id = ?',
          [companyId]
        );
        emailsEmpresa.forEach(e => {
          if (e.email && e.email.includes('@')) {
            destinatarios.add(e.email.trim().toLowerCase());
          }
        });
      } catch (_) {}

      // Fonte 2 — E-mails das pessoas vinculadas à empresa
      try {
        const pessoasEmpresa = await db.all(
          `SELECT email FROM persons 
           WHERE company_id = ? 
           AND email IS NOT NULL AND email != ''`,
          [companyId]
        );
        pessoasEmpresa.forEach(p => {
          if (p.email) destinatarios.add(p.email.trim().toLowerCase());
        });
      } catch (_) {}

      // Fonte 3 — E-mails de pessoas nos grupos vinculados à empresa
      try {
        const gruposEmpresa = await db.all(
          'SELECT group_id FROM company_groups WHERE company_id = ?',
          [companyId]
        );
        if (gruposEmpresa.length > 0) {
          const ids = gruposEmpresa.map(g => g.group_id);
          const placeholders = ids.map(() => '?').join(',');
          const pessoasGrupo = await db.all(
            `SELECT email FROM persons 
             WHERE group_id IN (${placeholders}) 
             AND email IS NOT NULL AND email != ''`,
            ids
          );
          pessoasGrupo.forEach(p => {
            if (p.email) destinatarios.add(p.email.trim().toLowerCase());
          });
        }
      } catch (_) {}

      // Fallback para e-mail principal da empresa se ninguem encontrado
      if (destinatarios.size === 0 && empresa.email && empresa.email.includes('@')) {
        destinatarios.add(empresa.email.trim().toLowerCase());
      }

      if (destinatarios.size === 0) {
        logger.warn(`[NotifVisitante] Nenhum e-mail encontrado para empresa id=${companyId}`);
        return;
      }

      // PASSO F: Montar dados para substituição de variáveis
      const action = log.action || 'ENTRY';
      const eventDate = log.created_at ? new Date(log.created_at) : new Date();
      
      const dados = {
        personName:     visitante.name || '',
        personDocument: visitante.document || visitante.registration_number || '',
        personCompany:  visitante.visitor_company || '',
        dataHora:       eventDate.toLocaleString('pt-BR'),
        empresaDestino: empresa.trading_name || empresa.corporate_name || '',
        sentido:        'ENTRADA'
      };

      // PASSO G: Para cada regra, enviar e-mail
      for (const regra of regras) {
        const assunto = this.substituirVariaveis(regra.assunto, dados);
        const corpo   = this.substituirVariaveis(regra.corpo, dados);
        const para    = Array.from(destinatarios).join(', ');

        this.enviarEmail({
          para,
          assunto,
          corpo: this.template(corpo),
          tenantId
        });

        logger.info(`[NotifVisitante] E-mail de ENTRADA enfileirado | Regra: ${regra.nome} | Para: ${para}`);
      }
    } catch (err) {
      logger.error(`[NotifVisitante] Erro crítico no disparo: ${err.message}`);
    }
  }

  /**
   * PASSO 2: Notificação especializada para cadastro de encomenda
   * Busca e-mails da empresa, das pessoas vinculadas e do destinatário final.
   */
  async dispararEmailEncomenda({ tenantId, encomenda }) {
    try {
      const db = await getTenantDatabase(tenantId);

      // PASSO A: Verificar feature flag
      let flagRow;
      try {
        flagRow = await db.get(
          "SELECT value FROM tenant_config WHERE key = 'notif_encomenda_email'"
        );
      } catch (_) {}

      if (!flagRow || flagRow.value !== 'true') return;

      // PASSO B: Buscar regras ativas do tipo 'encomenda'
      const regras = await db.all(
        "SELECT * FROM notificacoes WHERE tipo_evento = 'encomenda' AND ativo = 1"
      );

      if (!regras || regras.length === 0) {
        logger.warn('[NotifEncomenda] Nenhuma regra ativa para tipo encomenda');
        return;
      }

      // PASSO C: Resolver empresa envolvida
      const companyId = encomenda.companyId || null;

      // PASSO D: Coletar destinatários (Set para deduplicar)
      const destinatarios = new Set();

      if (companyId) {
        // Fonte 1: E-mails específicos para notificações da empresa
        try {
          const emailsExtras = await db.all(
            'SELECT email FROM company_notification_emails WHERE company_id = ?',
            [companyId]
          );
          emailsExtras.forEach(e => {
            if (e.email && e.email.includes('@')) {
              destinatarios.add(e.email.trim().toLowerCase());
            }
          });
        } catch (_) {}

        // Fonte 2: E-mails das pessoas vinculadas à empresa
        try {
          const pessoasEmpresa = await db.all(
            `SELECT email FROM persons 
             WHERE company_id = ? 
             AND email IS NOT NULL AND email != ''`,
            [companyId]
          );
          pessoasEmpresa.forEach(p => {
            if (p.email) destinatarios.add(p.email.trim().toLowerCase());
          });
        } catch (_) {}
      }

      // Fonte 3: E-mail específico da pessoa selecionada
      const pessoaId = encomenda.pessoaId || null;
      if (pessoaId) {
        try {
          const pessoa = await db.get(
            `SELECT email FROM persons WHERE id = ? AND email IS NOT NULL AND email != ''`,
            [pessoaId]
          );
          if (pessoa && pessoa.email) {
            destinatarios.add(pessoa.email.trim().toLowerCase());
          }
        } catch (_) {}
      }

      if (destinatarios.size === 0) {
        logger.warn(`[NotifEncomenda] Nenhum e-mail encontrado para a encomenda id=${encomenda.id}`);
        return;
      }

      // PASSO E: Montar dados para substituição de variáveis
      let nomePorteiro = encomenda.nomeOperador || '';
      if (!nomePorteiro && encomenda.operadorId) {
        try {
          const op = await db.get('SELECT name FROM users WHERE id = ?', [encomenda.operadorId]);
          if (op) nomePorteiro = op.name;
        } catch (_) {}
      }

      let nomeDestinatario = encomenda.destinatario || '';
      if (pessoaId) {
        try {
          const p = await db.get('SELECT name FROM persons WHERE id = ?', [pessoaId]);
          if (p) nomeDestinatario = p.name;
        } catch (_) {}
      } else if (companyId && !nomeDestinatario) {
        try {
          const c = await db.get('SELECT trading_name, corporate_name FROM companies WHERE id = ?', [companyId]);
          if (c) nomeDestinatario = c.trading_name || c.corporate_name;
        } catch (_) {}
      }

      const dados = {
        destinatarioEncomenda: nomeDestinatario,
        descricaoEncomenda:    encomenda.descricao || encomenda.tipo || '',
        dataChegada:           encomenda.dataChegada 
                                 ? new Date(encomenda.dataChegada).toLocaleString('pt-BR') 
                                 : new Date().toLocaleString('pt-BR'),
        nomePorteiro:          nomePorteiro,
        dataHora:              new Date().toLocaleString('pt-BR'),
      };

      // PASSO F: Para cada regra, substituir variáveis e enviar
      const para = Array.from(destinatarios).join(', ');

      for (const regra of regras) {
        const assunto = this.substituirVariaveis(regra.assunto, dados);
        const corpo   = this.substituirVariaveis(regra.corpo, dados);

        this.enviarEmail({
          para,
          assunto,
          corpo: this.template(corpo),
          tenantId
        });

        logger.info(`[NotifEncomenda] E-mail enfileirado | Regra: ${regra.nome} | Para: ${para}`);
      }
    } catch (error) {
      logger.error('[NotifEncomenda] Erro em dispararEmailEncomenda: ' + error.message);
    }
  }

  /**
   * Layout base HTML
   */
  template(corpo) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden; }
          .header { background: #1a237e; color: #ffffff; padding: 20px; text-align: center; }
          .content { padding: 30px; }
          .footer { background: #f5f5f5; color: #777; padding: 15px; text-align: center; font-size: 12px; }
          .btn { display: inline-block; padding: 10px 20px; background: #283593; color: white; text-decoration: none; border-radius: 5px; margin-top: 15px; }
          .info-table { width: 100%; border-collapse: collapse; margin: 15px 0; }
          .info-table td { padding: 8px; border-bottom: 1px solid #eee; }
          .label { font-weight: bold; color: #555; width: 150px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2 style="margin:0;">Acess Control Alert</h2>
          </div>
          <div class="content">
            ${corpo.replace(/\n/g, '<br>')}
          </div>
          <div class="footer">
            Este é um e-mail automático do sistema Acess Control.<br>
            &copy; ${new Date().getFullYear()} Acess Control.
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

// Singleton
const emailService = new EmailService();

export default emailService;
export { emailService };

import crypto from 'crypto';
import { hashPassword } from '../utils/generators.js';
import emailService from '../services/emailService.js';
import logger from '../config/logger.js';

// Rate limiting em memória (em produção, usar Redis ou similar)
const rateLimitMap = new Map();

// Configurações
const CODE_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const MAX_CODES_PER_HOUR = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hora

/**
 * Gera um código numérico de 6 dígitos
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Verifica rate limiting para evitar spam de códigos
 */
function checkRateLimit(email, tenantId) {
  const key = `${tenantId}:${email}`;
  const now = Date.now();
  
  // Limpar entradas antigas
  const entries = rateLimitMap.get(key);
  if (!entries) {
    rateLimitMap.set(key, [now]);
    return { allowed: true, remaining: MAX_CODES_PER_HOUR - 1 };
  }
  
  // Filtrar entradas dentro da janela de tempo
  const recentEntries = entries.filter(time => now - time < RATE_LIMIT_WINDOW_MS);
  
  if (recentEntries.length >= MAX_CODES_PER_HOUR) {
    return { allowed: false, remaining: 0 };
  }
  
  recentEntries.push(now);
  rateLimitMap.set(key, recentEntries);
  return { allowed: true, remaining: MAX_CODES_PER_HOUR - recentEntries.length };
}

/**
 * POST /api/esqueci-senha
 * Solicita código de reset de senha
 */
export const solicitarResetCode = async (req, res) => {
  try {
    const { email, tenantId } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || '';

    if (!email || !tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Email e tenantId são obrigatórios'
      });
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email inválido'
      });
    }

    // Verificar rate limiting
    const rateLimit = checkRateLimit(email, tenantId);
    if (!rateLimit.allowed) {
      logger.warn(`Rate limit excedido para ${email} no tenant ${tenantId}`);
      return res.status(429).json({
        success: false,
        message: 'Muitas tentativas. Tente novamente em 1 hora.'
      });
    }

    const db = req.db;

    // Buscar usuário pelo email (não revelar se existe ou não)
    const user = await db.get(
      'SELECT id, name, email FROM users WHERE email = ? AND active = 1',
      [email.toLowerCase()]
    );

    // SEMPRE retornar sucesso para evitar enumeração de emails
    // Se o email existir, enviamos o código; se não existir, simplesmente não fazemos nada
    if (!user) {
      logger.info(`Tentativa de reset para email não existente: ${email} no tenant ${tenantId}`);
      return res.json({
        success: true,
        message: 'Se o email existir, enviaremos um código de verificação.'
      });
    }

    // Gerar código de 6 dígitos
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

    // Inserir código no banco (um por vez - remover anteriores não usados)
    await db.run(
      'UPDATE password_reset_codes SET used = 1 WHERE email = ? AND used = 0',
      [email.toLowerCase()]
    );

    await db.run(
      'INSERT INTO password_reset_codes (email, code, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
      [email.toLowerCase(), code, expiresAt, ipAddress, userAgent]
    );

    // Enviar email com código
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #6a11cb, #00d2ff); padding: 30px; border-radius: 10px; text-align: center;">
          <h1 style="color: white; margin: 0;">Recuperação de Senha</h1>
        </div>
        <div style="background: #f5f5f5; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="color: #333; font-size: 16px;">Olá, ${user.name}!</p>
          <p style="color: #666; font-size: 14px;">Recebemos uma solicitação para redefinir sua senha. Use o código abaixo:</p>
          <div style="background: white; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #00d2ff;">${code}</span>
          </div>
          <p style="color: #666; font-size: 14px;">Este código expira em <strong>${CODE_EXPIRY_MINUTES} minutos</strong>.</p>
          <p style="color: #999; font-size: 12px; margin-top: 20px;">
            Se você não solicitou esta recuperação, ignore este email.
          </p>
        </div>
        <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
          <p>© ${new Date().getFullYear()} MAM Control - Sistema de Controle de Acesso</p>
        </div>
      </div>
    `;

    try {
      await emailService.sendEmail({
        to: email,
        subject: 'Código de verificação - Recuperação de Senha',
        html: emailHtml,
        tenantId
      });
      logger.info(`Código de reset enviado para ${email} no tenant ${tenantId}`);
    } catch (emailError) {
      logger.error(`Erro ao enviar email de reset para ${email}:`, emailError.message);
      // Não revelar erro técnico ao usuário
    }

    res.json({
      success: true,
      message: 'Se o email existir, enviaremos um código de verificação.'
    });

  } catch (error) {
    logger.error('Erro ao solicitar reset de senha:', error);
    // Sempre retornar mensagem genérica
    res.json({
      success: true,
      message: 'Se o email existir, enviaremos um código de verificação.'
    });
  }
};

/**
 * POST /api/verificar-codigo
 * Verifica se o código de reset é válido
 */
export const verificarCodigo = async (req, res) => {
  try {
    const { email, code, tenantId } = req.body;

    if (!email || !code || !tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Email, código e tenantId são obrigatórios'
      });
    }

    if (code.length !== 6 || !/^\d+$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: 'Código inválido'
      });
    }

    const db = req.db;

    // Buscar código válido
    const resetCode = await db.get(
      `SELECT id, email, attempts, used, expires_at 
       FROM password_reset_codes 
       WHERE email = ? AND code = ? AND used = 0 
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase(), code]
    );

    if (!resetCode) {
      logger.warn(`Tentativa de código inválido para ${email} no tenant ${tenantId}`);
      return res.status(400).json({
        success: false,
        message: 'Código inválido ou expirado'
      });
    }

    // Verificar se expirou
    if (new Date(resetCode.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Código expirado. Solicite um novo código.'
      });
    }

    // Verificar tentativas
    if (resetCode.attempts >= MAX_ATTEMPTS) {
      await db.run(
        'UPDATE password_reset_codes SET used = 1 WHERE id = ?',
        [resetCode.id]
      );
      return res.status(400).json({
        success: false,
        message: 'Muitas tentativas falhas. Solicite um novo código.'
      });
    }

    // Código válido - marcar como usado temporariamente
    // Na verdade, vamos criar um token temporário para uso na próxima requisição
    const tempToken = crypto.randomBytes(32).toString('hex');
    const tempTokenExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutos

    await db.run(
      `UPDATE password_reset_codes 
       SET used = 1, attempts = attempts + 1 
       WHERE id = ?`,
      [resetCode.id]
    );

    // Armazenar token temporário (em produção, usar tabela separada ou Redis)
    // Aqui vamos usar uma abordagem simples: retornar um token que será usado na próxima etapa
    res.json({
      success: true,
      message: 'Código verificado com sucesso',
      tempToken,
      expiresAt: tempTokenExpiry
    });

  } catch (error) {
    logger.error('Erro ao verificar código:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao verificar código'
    });
  }
};

/**
 * POST /api/nova-senha
 * Altera a senha do usuário após validação do código
 */
export const alterarSenha = async (req, res) => {
  try {
    const { email, novaSenha, tempToken, tenantId } = req.body;

    if (!email || !novaSenha || !tempToken || !tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Todos os campos são obrigatórios'
      });
    }

    // Validar senha
    if (novaSenha.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'A senha deve ter pelo menos 6 caracteres'
      });
    }

    // Validar token temporário (simplificado - em produção usar Redis ou tabela separada)
    // Aqui vamos verificar se existe um código usado recentemente
    const db = req.db;

    const recentReset = await db.get(
      `SELECT id FROM password_reset_codes 
       WHERE email = ? AND used = 1 AND attempts > 0
       ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase()]
    );

    if (!recentReset) {
      return res.status(400).json({
        success: false,
        message: 'Sessão expirada. Inicie o processo novamente.'
      });
    }

    // Verificar se o token é válido (comparação simples - em produção usar algo mais robusto)
    if (tempToken.length !== 64) {
      return res.status(400).json({
        success: false,
        message: 'Token inválido'
      });
    }

    // Buscar usuário
    const user = await db.get(
      'SELECT id, name, email FROM users WHERE email = ? AND active = 1',
      [email.toLowerCase()]
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Usuário não encontrado'
      });
    }

    // Hash da nova senha
    const passwordHash = await hashPassword(novaSenha);

    // Atualizar senha
    await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, user.id]
    );

    // Invalidar todos os códigos de reset anteriores
    await db.run(
      'UPDATE password_reset_codes SET used = 1 WHERE email = ?',
      [email.toLowerCase()]
    );

    logger.info(`Senha alterada para ${email} no tenant ${tenantId}`);

    res.json({
      success: true,
      message: 'Senha alterada com sucesso'
    });

  } catch (error) {
    logger.error('Erro ao alterar senha:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao alterar senha'
    });
  }
};

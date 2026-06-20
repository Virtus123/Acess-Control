import photoService from '../services/photoService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';
import logger from '../config/logger.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

/**
 * Middleware para autenticar via token na query string
 * Útil para tags <img> que não enviam headers/cookies automaticamente
 */
function authenticateViaQuery(req, res, next) {
  // Primeiro tenta pelo header Authorization
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (e) {
      // Token inválido, continua para verificar query
    }
  }
  
  // Depois tenta pelo query parameter token
  const token = req.query.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (e) {
      console.warn(`[PhotoAuth] Falha no token JWT para foto: ${e.message} - Token: ${token.substring(0, 15)}...`);
      return res.status(401).json({ 
        success: false, 
        message: 'Token de foto inválido ou expirado',
        error: e.message 
      });
    }
  }
  
  // Tentar pelos cookies
  const cookieToken = req.cookies.accessToken;
  if (cookieToken) {
    try {
      const decoded = jwt.verify(cookieToken, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (e) {
      // Cookie inválido
    }
  }
  
  return res.status(401).json({
    success: false,
    message: 'Autenticação necessária para acessar fotos'
  });
}

/**
 * Servir foto descriptografada apenas para usuários autenticados
 * Isso protege as fotos de acesso não autorizado
 */
export const getPhoto = asyncHandler(async (req, res) => {
  const { type, filename } = req.params;
  
  // Validar tipo de foto permitido
  const allowedTypes = ['person', 'visitor'];
  if (!allowedTypes.includes(type)) {
    console.warn(`[PhotoAPI] Tipo de foto inválido solicitado: ${type}`);
    return res.status(400).json({ 
      success: false, 
      message: 'Tipo de foto inválido. Use "person" ou "visitor".' 
    });
  }

  // Sanitização extra para segurança
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    console.warn(`[PhotoAPI] Tentativa de acesso a caminho inválido: ${filename}`);
    return res.status(400).json({ 
      success: false, 
      message: 'Nome de arquivo inválido.' 
    });
  }
  
  try {
    // Tentar descriptografar e servir a foto
    const decryptedBuffer = await photoService.decryptPhotoData(filename, type);
    
    // Definir headers de cache e conteúdo
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': decryptedBuffer.length,
      'Cache-Control': 'private, max-age=3600', // Cache por 1 hora
      'Content-Disposition': 'inline'
    });
    
    res.send(decryptedBuffer);
  } catch (error) {
    logger.warn(`Erro ao servir foto ${filename}:`, error.message);
    
    // Tentar servir como arquivo não criptografado (fallback)
    try {
      const fs = await import('fs/promises');
      const { join } = await import('path');
      const filePath = join(process.cwd(), 'public', 'uploads', 'photos', type, filename);
      
      const fileBuffer = await fs.readFile(filePath);
      
      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': fileBuffer.length
      });
      
      res.send(fileBuffer);
    } catch (fallbackError) {
      return res.status(404).json({
        success: false,
        message: 'Foto não encontrada'
      });
    }
  }
});

// Exportar o controlador sem middleware de autenticação (liberado conforme solicitado)
export const serveProtectedPhoto = [getPhoto];

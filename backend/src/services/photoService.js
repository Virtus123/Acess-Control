import sharp from 'sharp';
import fs from 'fs/promises';
import { join } from 'path';
import { generateFilename } from '../utils/generators.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/auth.js';

// Chave de criptografia para imagens (deve estar no .env em produção)
// ATENÇÃO: Sem chave fixa, as fotos não poderão ser descriptografadas após reiniciar o servidor
const ENCRYPTION_KEY = process.env.IMAGE_ENCRYPTION_KEY;
const IV_LENGTH = 16;

// Funções de criptografia AES-256-GCM
function encryptImage(buffer) {
  if (!ENCRYPTION_KEY) {
    // Sem chave, retornar buffer original (sem criptografia)
    return buffer;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Formato: IV + AuthTag + Dados criptografados
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptImage(buffer) {
  if (!ENCRYPTION_KEY || buffer.length < IV_LENGTH + 16) {
    // Sem chave ou buffer muito pequeno, retornar original
    return buffer;
  }
  
  // Verificar se parece ser um arquivo criptografado (tem IV + authTag no início)
  // Arquivos normais JPEG começam com FF D8 FF
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    try {
      const iv = buffer.subarray(0, IV_LENGTH);
      const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + 16);
      const encrypted = buffer.subarray(IV_LENGTH + 16);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
      decipher.setAuthTag(authTag);
      
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch (e) {
      // Falha na descriptografia, retornar buffer original
      return buffer;
    }
  }
  
  // Já é um JPEG normal, retornar como está
  return buffer;
}

class PhotoService {
  // Processar foto a partir de base64 (capturada pela câmera)
  async processBase64Photo(base64Data, type = 'person', desiredFilename = null, tenantId = null) {
    try {
      // Remover o prefixo data:image/jpeg;base64, se houver
      const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Image, 'base64');
      
      // Criar um objeto similar a um arquivoupload
      const fakeFile = {
        buffer: imageBuffer,
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg'
      };
      
      return this.processPhoto(fakeFile, type, desiredFilename, tenantId);
    } catch (error) {
      console.error('Erro ao processar foto base64:', error);
      throw error;
    }
  }

  async processPhoto(file, type = 'person', desiredFilename = null, tenantId = null) {
    try {
      const maxWidth = 500;
      const maxHeight = 500;
      const quality = 80;

      // Processar a foto com sharp
      const processedBuffer = await sharp(file.buffer || file.path)
        .resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality })
        .toBuffer();
      
      // Criptografar a imagem antes de salvar (apenas se houver chave)
      const finalBuffer = ENCRYPTION_KEY ? encryptImage(processedBuffer) : processedBuffer;
      
      // Definir extensão baseada em chave de criptografia
      const hasEncryption = !!ENCRYPTION_KEY;
      const extension = hasEncryption ? 'enc' : 'jpg';
      
      let filename;
      if (desiredFilename) {
        const prefix = tenantId ? `${tenantId}_` : '';
        const baseName = desiredFilename.replace(/\.(jpg|jpeg)$/i, '');
        filename = `${prefix}${baseName}.${extension}`;
      } else {
        filename = generateFilename(type, extension);
      }
      
      const uploadPath = join(process.cwd(), 'public', 'uploads', 'photos', type);
      
      await fs.mkdir(uploadPath, { recursive: true });
      
      const filePath = join(uploadPath, filename);
      // Salvar arquivo (criptografado ou não)
      await fs.writeFile(filePath, finalBuffer);

      return {
        filename,
        path: filePath,
        url: `/uploads/photos/${type}/${filename}`,
        size: processedBuffer.length
      };
    } catch (error) {
      throw new Error(`Erro ao processar foto: ${error.message}`);
    }
  }

  /**
   * Decodificar imagem criptografada (para servir ao frontend)
   */
  async decryptPhotoData(filename, type = 'person') {
    try {
      const uploadPath = join(process.cwd(), 'public', 'uploads', 'photos', type);
      let filePath = join(uploadPath, filename);
      
      // Se arquivo não existe, tentar com .enc (se a requisição foi por .jpg)
      // ou apenas procurar pelo arquivo .enc correspondente
      try {
        await fs.access(filePath);
      } catch (e) {
        if (filename.toLowerCase().endsWith('.jpg')) {
          const encFilename = filename.replace(/\.jpg$/i, '.enc');
          const encPath = join(uploadPath, encFilename);
          try {
            await fs.access(encPath);
            filePath = encPath;
          } catch (e2) {
            throw e; // Re-throw original 404
          }
        } else {
          throw e; // Re-throw original 404
        }
      }
      
      const encryptedBuffer = await fs.readFile(filePath);
      const decryptedBuffer = decryptImage(encryptedBuffer);
      
      return decryptedBuffer;
    } catch (error) {
      throw new Error(`Erro ao descriptografar foto: ${error.message}`);
    }
  }
  
  /**
   * Deletar foto do sistema de arquivos
   */
  async deletePhoto(filename, type = 'person') {
    try {
      if (!filename) return true;
      const uploadPath = join(process.cwd(), 'public', 'uploads', 'photos', type);
      const filePath = join(uploadPath, filename);
      
      // Verificar se arquivo existe antes de tentar deletar
      try {
        await fs.access(filePath);
        await fs.unlink(filePath);
      } catch (err) {
        // Arquivo não existe, ignorar
      }
      return true;
    } catch (error) {
      console.error(`Erro ao deletar foto: ${error.message}`);
      return false;
    }
  }

  /**
   * Gerar URL pública simples sem token
   */
  generatePublicUrl(filename, type = 'visitor', baseUrl = null) {
    if (!filename) return null;
    
    // Garante que não estamos repetindo caminhos ou adicionando tokens
    const cleanFilename = filename.split('/').pop().split('?')[0];
    
    // Forçar extensão .jpg para compatibilidade externa (nosso middleware resolve de volta pra .enc se precisar)
    const displayFilename = cleanFilename.replace(/\.enc$/i, '.jpg');
    
    const relativeUrl = `/uploads/photos/${type}/${displayFilename}`;
    
    if (baseUrl) {
      const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      return `${base}${relativeUrl}`;
    }
    
    return relativeUrl;
  }

  /**
   * Gerar URL assinada (agora apenas um alias para a URL pública já que a rota é aberta)
   */
  generateSignedUrl(filename, type = 'visitor', expiresIn = '1h', baseUrl = null) {
    return this.generatePublicUrl(filename, type, baseUrl);
  }
}

export default new PhotoService();




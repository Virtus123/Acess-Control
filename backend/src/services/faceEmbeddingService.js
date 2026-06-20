/**
 * Serviço de Extração de Embedding Facial
 * Usa TensorFlow.js para extrair características faciais
 * Temporariamente desabilitado
 */

// TensorFlow desabilitado temporariamente
// import * as tf from '@tensorflow/tfjs-node';
import sharp from 'sharp';
import logger from '../config/logger.js';

// Modelo global (carregado uma vez)
let faceModel = null;
let modelLoaded = false;

/**
 * Carrega o modelo FaceNet para extração de embeddings
 * O modelo pode ser baixado de: https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 * Temporariamente desabilitado - retorna null
 */
async function loadModel() {
    if (modelLoaded && faceModel) {
        return faceModel;
    }

    try {
        logger.info('🔄 Carregando modelo de reconhecimento facial...');
        
        // Temporariamente desabilitado - retornar null para funcionar sem TensorFlow
        logger.warn('⚠️ TensorFlow desabilitado temporariamente');
        modelLoaded = true;
        return null;
    } catch (error) {
        logger.error('❌ Erro ao carregar modelo de reconhecimento facial:', error);
        modelLoaded = true;
        return null;
    }
}

/**
 * Pré-processa a imagem para o formato esperado pelo modelo
 * Temporariamente desabilitado
 * @param {Buffer} imageBuffer - Buffer da imagem
 * @returns {Tensor} Tensor preprocessado
 */
async function preprocessImage(imageBuffer) {
    // Temporariamente desabilitado
    return null;
}

/**
 * Calcula a distância euclidiana entre dois embeddings
 * @param {Array} embedding1 - Primeiro embedding
 * @param {Array} embedding2 - Segundo embedding
 * @returns {Number} Distância euclidiana
 */
export function calculateDistance(embedding1, embedding2) {
    if (!embedding1 || !embedding2 || embedding1.length !== embedding2.length) {
        return Infinity;
    }
    
    let sum = 0;
    for (let i = 0; i < embedding1.length; i++) {
        const diff = embedding1[i] - embedding2[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

/**
 * Compara dois embeddings e retorna a similaridade (0 a 1)
 * @param {Array} embedding1 - Primeiro embedding
 * @param {Array} embedding2 - Segundo embedding
 * @returns {Number} Similaridade (1 = mesma pessoa, 0 = pessoas diferentes)
 */
export function calculateSimilarity(embedding1, embedding2) {
    const distance = calculateDistance(embedding1, embedding2);
    
    // Converter distância para similaridade usando Gaussiana
    // Threshold típico: 0.6 (pode ajustar conforme necessidade)
    const threshold = 0.6;
    
    if (distance > threshold) {
        return 0;
    }
    
    // Similaridade invertida: menor distância = maior similaridade
    return 1 - (distance / threshold);
}

/**
 * Extrai o embedding facial de uma imagem Base64
 * @param {string} base64String - Imagem em Base64 (com ou sem cabeçalho)
 * @returns {Object} - { embedding: Array, error: string | null }
 */
export async function extractEmbedding(base64String) {
    try {
        if (!base64String) {
            return { embedding: null, error: 'Imagem não fornecida' };
        }

        logger.info('🔍 Processando imagem para extrair embedding facial...');

        // Decodificar Base64
        let base64Data = base64String;
        if (base64String.includes(',')) {
            base64Data = base64String.split(',')[1];
        }

        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        // Verificar se a imagem é válida
        if (imageBuffer.length < 100) {
            return { embedding: null, error: 'Imagem muito pequena ou inválida' };
        }

        // Tentar carregar o modelo
        const model = await loadModel();
        
        if (!model) {
            // Modelo não disponível - retornar null (sistema funciona sem embedding)
            logger.warn('⚠️ Modelo de embedding não disponível, salvando sem embedding');
            return { embedding: null, error: 'Modelo não disponível' };
        }

        // Pré-processar imagem
        const processedTensor = await preprocessImage(imageBuffer);
        
        // Extrair embedding
        const prediction = model.predict(processedTensor);
        const embedding = await prediction.array();
        
        // O embedding é o primeiro (e único) item do batch
        const faceEmbedding = embedding[0];
        
        // Verificar se é um embedding válido
        if (!faceEmbedding || faceEmbedding.length === 0) {
            return { embedding: null, error: 'Não foi possível extrair embedding da imagem' };
        }

        // Limpar memória
        processedTensor.dispose();
        prediction.dispose();

        logger.info(`✅ Embedding extraído: ${faceEmbedding.length} dimensões`);
        
        return { 
            embedding: faceEmbedding, 
            error: null 
        };

    } catch (error) {
        logger.error('❌ Erro ao extrair embedding:', error);
        return { 
            embedding: null, 
            error: error.message 
        };
    }
}

/**
 * Busca pessoa pelo embedding facial
 * @param {string} base64String - Foto em Base64 para busca
 * @param {Array} persons - Array de pessoas cadastradas com embeddings
 * @param {number} threshold - Limite de similaridade (0-1), padrão 0.6
 * @returns {Object} - { person: Object | null, similarity: number }
 */
export async function findPersonByFace(base64String, persons, threshold = 0.6) {
    try {
        // Extrair embedding da foto de busca
        const { embedding: searchEmbedding, error } = await extractEmbedding(base64String);
        
        if (error || !searchEmbedding) {
            logger.warn('Não foi possível extrair embedding da imagem de busca:', error);
            return { person: null, similarity: 0, error };
        }

        let bestMatch = null;
        let bestSimilarity = 0;

        // Comparar com todos os embeddings cadastrados
        for (const person of persons) {
            if (!person.face_embedding) {
                continue;
            }

            try {
                // Parse do embedding salvo como JSON
                const storedEmbedding = typeof person.face_embedding === 'string' 
                    ? JSON.parse(person.face_embedding) 
                    : person.face_embedding;

                if (!storedEmbedding || !Array.isArray(storedEmbedding)) {
                    continue;
                }

                const similarity = calculateSimilarity(searchEmbedding, storedEmbedding);
                
                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestMatch = person;
                }
            } catch (parseError) {
                logger.warn('Erro ao processar embedding armazenado:', parseError);
                continue;
            }
        }

        // Verificar se atende ao threshold
        if (bestSimilarity >= threshold && bestMatch) {
            logger.info(`✅ Face identificada: ${bestMatch.name} (similaridade: ${bestSimilarity.toFixed(2)})`);
            return { 
                person: bestMatch, 
                similarity: bestSimilarity,
                error: null 
            };
        }

        logger.info('🔍 Nenhuma correspondência facial encontrada');
        return { 
            person: null, 
            similarity: bestSimilarity,
            error: null 
        };

    } catch (error) {
        logger.error('❌ Erro na busca por face:', error);
        return { person: null, similarity: 0, error: error.message };
    }
}

/**
 * Verifica se uma foto contém um rosto válido
 * @param {string} base64String - Foto em Base64
 * @returns {boolean}
 */
export async function validateFacePhoto(base64String) {
    try {
        if (!base64String) {
            return false;
        }

        let base64Data = base64String;
        if (base64String.includes(',')) {
            base64Data = base64String.split(',')[1];
        }

        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        // Verificar tamanho mínimo (10KB)
        if (imageBuffer.length < 10000) {
            return false;
        }

        // Verificar dimensões da imagem
        const metadata = await sharp(imageBuffer).metadata();
        
        // Imagem muito pequena
        if (metadata.width < 100 || metadata.height < 100) {
            return false;
        }

        return true;
    } catch (error) {
        logger.error('Erro ao validar foto:', error);
        return false;
    }
}

export default {
    extractEmbedding,
    calculateDistance,
    calculateSimilarity,
    findPersonByFace,
    validateFacePhoto,
    loadModel
};

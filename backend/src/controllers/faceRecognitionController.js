/**
 * Controller para Reconhecimento Facial
 * Permite identificar pessoas pelo rosto
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { findPersonByFace, extractEmbedding, validateFacePhoto } from '../services/faceEmbeddingService.js';

/**
 * POST /api/face/identify
 * Identifica uma pessoa pela foto
 */
export const identifyPerson = asyncHandler(async (req, res) => {
    const db = req.db;
    const { photo_base64, photo, threshold = 0.6 } = req.body;
    
    // Usar qualquer campo de foto disponível
    const base64Photo = photo_base64 || photo;
    
    if (!base64Photo) {
        return res.status(400).json({
            success: false,
            message: 'Foto não fornecida'
        });
    }
    
    // Validar a foto
    const isValid = await validateFacePhoto(base64Photo);
    if (!isValid) {
        return res.status(400).json({
            success: false,
            message: 'Foto inválida ou muito pequena'
        });
    }
    
    // Buscar todas as pessoas com embedding cadastrado
    const persons = await db.all(`
        SELECT id, name, registration_number, company_id, group_id, photo_base64, face_embedding
        FROM persons 
        WHERE status = 'active' 
        AND face_embedding IS NOT NULL 
        AND face_embedding != ''
    `);
    
    if (persons.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'Nenhuma pessoa cadastrada com reconhecimento facial'
        });
    }
    
    // Buscar pessoa pelo rosto
    const { person, similarity, error } = await findPersonByFace(base64Photo, persons, parseFloat(threshold));
    
    if (error) {
        return res.status(500).json({
            success: false,
            message: 'Erro ao processar reconhecimento facial',
            error
        });
    }
    
    if (!person) {
        return res.status(404).json({
            success: false,
            message: 'Pessoa não identificada',
            similarity: similarity
        });
    }
    
    // Buscar informações adicionais da pessoa
    const company = person.company_id ? await db.get('SELECT id, corporate_name, trading_name FROM companies WHERE id = ?', [person.company_id]) : null;
    const group = person.group_id ? await db.get('SELECT id, name FROM groups WHERE id = ?', [person.group_id]) : null;
    
    return res.status(200).json({
        success: true,
        data: {
            person: {
                id: person.id,
                name: person.name,
                registration_number: person.registration_number,
                company: company ? {
                    id: company.id,
                    corporate_name: company.corporate_name,
                    trading_name: company.trading_name
                } : null,
                group: group ? {
                    id: group.id,
                    name: group.name
                } : null,
                photo_base64: person.photo_base64
            },
            similarity: similarity,
            confidence: Math.round(similarity * 100)
        },
        message: 'Pessoa identificada com sucesso'
    });
});

/**
 * POST /api/face/verify
 * Verifica se a pessoa é quem diz ser (comparando com o ID fornecido)
 */
export const verifyPerson = asyncHandler(async (req, res) => {
    const db = req.db;
    const { person_id, photo_base64, photo, threshold = 0.6 } = req.body;
    
    // Usar qualquer campo de foto disponível
    const base64Photo = photo_base64 || photo;
    
    if (!person_id) {
        return res.status(400).json({
            success: false,
            message: 'ID da pessoa não fornecido'
        });
    }
    
    if (!base64Photo) {
        return res.status(400).json({
            success: false,
            message: 'Foto não fornecida'
        });
    }
    
    // Buscar a pessoa pelo ID
    const person = await db.get(`
        SELECT id, name, registration_number, face_embedding, photo_base64
        FROM persons 
        WHERE id = ? AND status = 'active'
    `, [person_id]);
    
    if (!person) {
        return res.status(404).json({
            success: false,
            message: 'Pessoa não encontrada'
        });
    }
    
    if (!person.face_embedding) {
        return res.status(400).json({
            success: false,
            message: 'Pessoa não possui cadastro de reconhecimento facial'
        });
    }
    
    // Extrair embedding da foto enviada
    const { embedding: searchEmbedding, error: extractError } = await extractEmbedding(base64Photo);
    
    if (extractError || !searchEmbedding) {
        return res.status(400).json({
            success: false,
            message: 'Não foi possível processar a foto',
            error: extractError
        });
    }
    
    // Parse do embedding armazenado
    try {
        const storedEmbedding = typeof person.face_embedding === 'string' 
            ? JSON.parse(person.face_embedding) 
            : person.face_embedding;
        
        // Importar a função de cálculo de distância
        const { calculateSimilarity } = await import('../services/faceEmbeddingService.js');
        const similarity = calculateSimilarity(searchEmbedding, storedEmbedding);
        
        const isVerified = similarity >= parseFloat(threshold);
        
        return res.status(200).json({
            success: true,
            data: {
                verified: isVerified,
                similarity: similarity,
                confidence: Math.round(similarity * 100),
                person: {
                    id: person.id,
                    name: person.name,
                    registration_number: person.registration_number
                }
            },
            message: isVerified ? 'Pessoa verificada com sucesso' : 'Não foi possível verificar a identidade'
        });
        
    } catch (parseError) {
        return res.status(500).json({
            success: false,
            message: 'Erro ao processar dados de reconhecimento facial',
            error: parseError.message
        });
    }
});

/**
 * POST /api/face/enroll
 * Cadastra/Atualiza o embedding facial de uma pessoa
 */
export const enrollPerson = asyncHandler(async (req, res) => {
    const db = req.db;
    const { person_id, photo_base64, photo } = req.body;
    
    // Usar qualquer campo de foto disponível
    const base64Photo = photo_base64 || photo;
    
    if (!person_id) {
        return res.status(400).json({
            success: false,
            message: 'ID da pessoa não fornecido'
        });
    }
    
    if (!base64Photo) {
        return res.status(400).json({
            success: false,
            message: 'Foto não fornecida'
        });
    }
    
    // Validar a foto
    const isValid = await validateFacePhoto(base64Photo);
    if (!isValid) {
        return res.status(400).json({
            success: false,
            message: 'Foto inválida ou muito pequena'
        });
    }
    
    // Verificar se a pessoa existe
    const person = await db.get('SELECT id, name FROM persons WHERE id = ?', [person_id]);
    
    if (!person) {
        return res.status(404).json({
            success: false,
            message: 'Pessoa não encontrada'
        });
    }
    
    // Extrair embedding da foto
    const { embedding, error } = await extractEmbedding(base64Photo);
    
    if (error || !embedding) {
        return res.status(400).json({
            success: false,
            message: 'Não foi possível extrair embedding da foto',
            error
        });
    }
    
    // Atualizar o embedding no banco
    await db.run(`
        UPDATE persons 
        SET face_embedding = ?, photo_base64 = ?, updated_at = ?
        WHERE id = ?
    `, [JSON.stringify(embedding), base64Photo, new Date().toISOString(), person_id]);
    
    return res.status(200).json({
        success: true,
        message: 'Cadastro facial atualizado com sucesso',
        data: {
            person_id: person_id,
            name: person.name,
            embedding_dimensions: embedding.length
        }
    });
});

/**
 * DELETE /api/face/enroll/:personId
 * Remove o cadastro facial de uma pessoa
 */
export const removeEnrollment = asyncHandler(async (req, res) => {
    const db = req.db;
    const { personId } = req.params;
    
    const person = await db.get('SELECT id, name FROM persons WHERE id = ?', [personId]);
    
    if (!person) {
        return res.status(404).json({
            success: false,
            message: 'Pessoa não encontrada'
        });
    }
    
    await db.run(`
        UPDATE persons 
        SET face_embedding = NULL, updated_at = ?
        WHERE id = ?
    `, [new Date().toISOString(), personId]);
    
    return res.status(200).json({
        success: true,
        message: 'Cadastro facial removido com sucesso'
    });
});

/**
 * GET /api/face/stats
 * Retorna estatísticas de reconhecimento facial
 */
export const getFaceStats = asyncHandler(async (req, res) => {
    const db = req.db;
    
    const totalPersons = await db.get('SELECT COUNT(*) as count FROM persons WHERE status = ?', ['active']);
    const personsWithFace = await db.get(`
        SELECT COUNT(*) as count 
        FROM persons 
        WHERE status = 'active' 
        AND face_embedding IS NOT NULL 
        AND face_embedding != ''
    `);
    const totalVisitors = await db.get('SELECT COUNT(*) as count FROM visitors');
    const visitorsWithFace = await db.get(`
        SELECT COUNT(*) as count 
        FROM visitors 
        WHERE face_embedding IS NOT NULL 
        AND face_embedding != ''
    `);
    
    return res.status(200).json({
        success: true,
        data: {
            persons: {
                total: totalPersons?.count || 0,
                with_face_enrollment: personsWithFace?.count || 0,
                without_face_enrollment: (totalPersons?.count || 0) - (personsWithFace?.count || 0)
            },
            visitors: {
                total: totalVisitors?.count || 0,
                with_face_enrollment: visitorsWithFace?.count || 0
            }
        }
    });
});

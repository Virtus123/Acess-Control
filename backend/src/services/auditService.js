import { getTenantDatabase } from '../middleware/tenantManager.js';
import logger from '../config/logger.js';

class AuditService {
    /**
     * Log an action to the audit_logs table
     * @param {Object} params 
     * @param {string} params.tenant_id 
     * @param {number} params.user_id 
     * @param {string} params.user_name 
     * @param {string} params.action - CREATE, UPDATE, DELETE, LOGIN, etc.
     * @param {string} params.entity_type - person, visitor, user, etc.
     * @param {number} params.entity_id 
     * @param {string} params.description 
     * @param {Object} [params.old_values] - Object representing previous state
     * @param {Object} [params.new_values] - Object representing new state
     * @param {string} [params.ip_address] 
     * @param {string} [params.user_agent] 
     */
    async logAction(params) {
        try {
            let {
                tenant_id,
                user_id,
                user_name,
                action,
                entity_type,
                entity_id,
                description,
                old_values,
                new_values,
                ip_address,
                user_agent,
                req
            } = params;

            // Se req for passado, extrair dados automáticos se estiverem faltando
            if (req) {
                tenant_id = tenant_id || req.tenantId || req.body?.tenant_id || req.query?.tenant_id;
                user_id = user_id || req.user?.id;
                user_name = user_name || req.user?.name || req.user?.email;
                ip_address = ip_address || req.ip || req.headers?.['x-forwarded-for'];
                user_agent = user_agent || req.headers?.['user-agent'];
            }

            if (!tenant_id) return;

            const db = await getTenantDatabase(tenant_id);

            await db.run(
                `INSERT INTO audit_logs (
                    user_id, user_name, action, entity_type, entity_id, 
                    description, old_values, new_values, ip_address, user_agent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    user_id || null,
                    user_name || null,
                    action,
                    entity_type,
                    entity_id || null,
                    description || null,
                    old_values ? (typeof old_values === 'object' ? JSON.stringify(old_values) : old_values) : null,
                    new_values ? (typeof new_values === 'object' ? JSON.stringify(new_values) : new_values) : null,
                    ip_address || null,
                    user_agent || null
                ]
            );
        } catch (error) {
            logger.error('Error logging audit action:', { 
                action: params.action, entity_type: params.entity_type, error: error.message 
            });
        }
    }

    /**
     * Helper to log entity creation
     * Suporta: logCreate(req, { entityType, entityId, description, newData })
     * OU: logCreate(req, entityType, entityId, description, newData)
     */
    async logCreate(req, typeOrOpts, entityId, description, newData) {
        if (typeOrOpts && typeof typeOrOpts === 'object') {
            const { entityType, entityId: id, description: desc, newData: data } = typeOrOpts;
            return this.logAction({ req, action: 'CREATE', entity_type: entityType, entity_id: id, description: desc, new_values: data });
        }
        return this.logAction({ req, action: 'CREATE', entity_type: typeOrOpts, entity_id: entityId, description, new_values: newData });
    }

    /**
     * Helper to log entity update
     * Suporta: logUpdate(req, { entityType, entityId, description, oldData, newData })
     * OU: logUpdate(req, entityType, entityId, description, oldData, newData)
     */
    async logUpdate(req, typeOrOpts, entityId, description, oldData, newData) {
        let finalType = typeOrOpts;
        let finalId = entityId;
        let finalDesc = description;
        let finalOld = oldData;
        let finalNew = newData;

        if (typeOrOpts && typeof typeOrOpts === 'object') {
            finalType = typeOrOpts.entityType;
            finalId = typeOrOpts.entityId;
            finalDesc = typeOrOpts.description;
            finalOld = typeOrOpts.oldData;
            finalNew = typeOrOpts.newData;
        }

        // Enriquecer descrição com campos alterados
        if (finalOld && finalNew) {
            const changedFields = [];
            const labels = {
                'name': 'Nome',
                'nome': 'Nome',
                'email': 'Email',
                'role': 'Perfil',
                'active': 'Ativo',
                'cpf': 'CPF',
                'document': 'Documento',
                'registration_number': 'Matrícula',
                'corporate_name': 'Razão Social',
                'trading_name': 'Nome Fantasia',
                'cnpj': 'CNPJ',
                'phone': 'Telefone',
                'cellphone': 'Celular',
                'group_id': 'Grupo',
                'company_id': 'Empresa',
                'status': 'Status',
                'plate': 'Placa',
                'license_plate': 'Placa',
                'brand': 'Marca',
                'model': 'Modelo',
                'color': 'Cor',
                'year': 'Ano',
                'parking_id': 'Estacionamento',
                'spot_number': 'Vaga',
                'tag_number': 'Tag',
                'config_value': 'Valor',
                'config_key': 'Chave',
                'local': 'Local',
                'location': 'Localização',
                'capacidade': 'Capacidade',
                'capacity': 'Capacidade',
                'tipo': 'Tipo',
                'horario_abertura': 'H. Abertura',
                'horario_fechamento': 'H. Fechamento',
                'observacoes': 'Observações',
                'description': 'Descrição',
                'profile_id': 'Perfil de Acesso',
                'codigo': 'Código',
                'categoria': 'Categoria',
                'urgente': 'Urgente',
                'peso': 'Peso',
                'destinatario_nome': 'Destinatário',
                'remetente_nome': 'Remetente',
                'data_chegada': 'Chegada',
                'data_retirada': 'Retirada',
                'responsavel_retirada': 'Responsável'
            };

            const keys = new Set([...Object.keys(finalOld || {}), ...Object.keys(finalNew || {})]);
            keys.forEach(key => {
                if (['updated_at', 'created_at', 'password_hash', 'id', 'tenant_id', 'face_embedding'].includes(key)) return;
                
                // Comparação simples (JSON stringify para objetos/arrays)
                const oldVal = finalOld && typeof finalOld[key] === 'object' ? JSON.stringify(finalOld[key]) : (finalOld ? finalOld[key] : null);
                const newVal = finalNew && typeof finalNew[key] === 'object' ? JSON.stringify(finalNew[key]) : (finalNew ? finalNew[key] : null);

                if (oldVal !== newVal) {
                    changedFields.push(labels[key] || key);
                }
            });

            if (changedFields.length > 0) {
                const changesStr = ` (Alterou: ${changedFields.join(', ')})`;
                if (!finalDesc.includes(changesStr)) {
                    finalDesc += changesStr;
                }
            }
        }

        return this.logAction({ 
            req, 
            action: 'UPDATE', 
            entity_type: finalType, 
            entity_id: finalId, 
            description: finalDesc, 
            old_values: finalOld, 
            new_values: finalNew 
        });
    }

    /**
     * Helper to log entity deletion
     * Suporta: logDelete(req, { entityType, entityId, description, oldData })
     * OU: logDelete(req, entityType, entityId, description, oldData)
     */
    async logDelete(req, typeOrOpts, entityId, description, oldData) {
        if (typeOrOpts && typeof typeOrOpts === 'object') {
            const { entityType, entityId: id, description: desc, oldData: old } = typeOrOpts;
            return this.logAction({ req, action: 'DELETE', entity_type: entityType, entity_id: id, description: desc, old_values: old });
        }
        return this.logAction({ req, action: 'DELETE', entity_type: typeOrOpts, entity_id: entityId, description, old_values: oldData });
    }
}

export default new AuditService();

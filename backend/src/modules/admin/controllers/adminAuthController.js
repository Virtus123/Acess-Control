import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import globalDb from '../../../config/globalDatabase.js';
import dbManager from '../../../config/database.js';
import logger from '../../../config/logger.js';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

/**
 * Controller de Autenticação Administrativa Global (Plano 2.1)
 */
class AdminAuthController {
    /**
     * Handler de Login Administrativo (Nova Lógica Cirúrgica)
     */
    async login(req, res) {
        const { email, password } = req.body;

        try {
            if (!email || !password) {
                return res.status(400).json({ success: false, message: 'Email e senha são obrigatórios.' });
            }

            // Regra Crítica 2.1: Buscar EXCLUSIVAMENTE na tabela admins (Banco Global)
            const sql = 'SELECT * FROM admins WHERE email = ? AND is_active = 1';
            let admin = await globalDb.get(sql, [email]);
            let isRevenda = false;

            if (!admin) {
                // Se não achou em admins, busca se é um login de Revenda na base master
                const dbMaster = await dbManager.getSystemConnection();
                try {
                    const revenda = await dbMaster.get('SELECT * FROM revendas WHERE admin_email = ?', [email]);
                    if (revenda) {
                        // Verifica senha da revenda (plaintext legado ou bcrypt se houver)
                        if (password !== revenda.admin_password && !(await bcrypt.compare(password, revenda.admin_password).catch(()=>false))) {
                            return res.status(401).json({ success: false, message: 'Credenciais administrativas inválidas.' });
                        }
                        admin = {
                            id: revenda.id,
                            email: revenda.admin_email,
                            role: 'revenda',
                            name: revenda.corporate_name
                        };
                        isRevenda = true;
                    }
                } finally {
                    await dbManager.closeSystemConnection();
                }

                if (!admin) {
                    logger.warn(`[AdminAudit] Tentativa de login inválida | Email: ${email} | IP: ${req.ip}`);
                    return res.status(401).json({ success: false, message: 'Credenciais administrativas inválidas.' });
                }
            }

            // Validar senha com bcrypt (Apenas admins globais. Revendas já foram validadas acima)
            if (!isRevenda) {
                const isValidPassword = await bcrypt.compare(password, admin.password_hash);
                if (!isValidPassword) {
                    logger.warn(`[AdminAudit] Senha incorreta | Email: ${email} | IP: ${req.ip}`);
                    return res.status(401).json({ success: false, message: 'Credenciais administrativas inválidas.' });
                }
            }

            // Gerar JWT com Payload 2.1
            const payload = {
                type: "admin",
                admin_id: admin.id,
                email: admin.email,
                role: admin.role
            };

            // Regra Crítica 2.1: Expiração OBRIGATÓRIA de 8h
            const token = jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '8h' });

            logger.info(`[AdminAudit] ${email} | LOGIN REALIZADO COM SUCESSO | METHOD POST /admin/login | ${new Date().toISOString()}`);

            return res.json({
                success: true,
                message: 'Autenticação administrativa bem-sucedida.',
                token,
                admin: {
                    id: admin.id,
                    email: admin.email,
                    role: admin.role,
                    name: admin.name || 'Administrador'
                }
            });

        } catch (error) {
            logger.error(`[AdminAudit] Erro crítico no login administrativo | Email: ${email} | Erro: ${error.message}`);
            return res.status(500).json({ success: false, message: 'Erro interno na autenticação.' });
        }
    }

    /**
     * Registra um novo administrador (Plano 2.1 - Fase 3)
     * Restrito a Super Admin através do middleware de rotas.
     */
    async registerAdmin(req, res) {
        const { email, password, role } = req.body;

        try {
            if (!email || !password || !role) {
                return res.status(400).json({ success: false, message: 'Campos e-mail, senha e role são obrigatórios.' });
            }

            // Validar role (Plano 2.1: super_admin | support)
            if (!['super_admin', 'support'].includes(role)) {
                return res.status(400).json({ success: false, message: 'Role inválida. Use super_admin ou support.' });
            }

            // Gerar hash com rounds 12 (Padrão 2.1)
            const hash = await bcrypt.hash(password, 12);

            const sql = 'INSERT INTO admins (email, password_hash, role) VALUES (?, ?, ?)';
            const result = await globalDb.run(sql, [email, hash, role]);

            logger.info(`[AdminAudit] ${req.admin.email} | CRIOU NOVO ADMIN ${email} (Role: ${role}) | ${new Date().toISOString()}`);

            return res.status(201).json({
                success: true,
                message: 'Administrador criado com sucesso.',
                admin_id: result.lastID
            });

        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ success: false, message: 'E-mail administrativo já cadastrado.' });
            }
            logger.error(`[AdminAudit] Erro ao criar admin: ${error.message}`);
            return res.status(500).json({ success: false, message: 'Erro ao processar criação do admin.' });
        }
    }

    /**
     * Retorna dados do administrador atual (Check de Token)
     */
    async me(req, res) {
        return res.json({
            success: true,
            admin: req.admin
        });
    }

    /**
     * Atualiza o perfil do administrador logado (Email e Senha)
     * Plano 2.1 - Fase 5
     */
    async updateProfile(req, res) {
        const { email, current_password, new_password } = req.body;
        const adminId = req.admin.admin_id;

        try {
            // 1. Buscar admin atual
            const admin = await globalDb.get('SELECT * FROM admins WHERE id = ?', [adminId]);
            if (!admin) {
                return res.status(404).json({ success: false, message: 'Administrador não encontrado.' });
            }

            // 2. Validar senha atual se estiver tentando mudar email ou senha
            if (current_password) {
                const isValid = await bcrypt.compare(current_password, admin.password_hash);
                if (!isValid) {
                    return res.status(401).json({ success: false, message: 'Senha atual incorreta.' });
                }
            } else {
                return res.status(400).json({ success: false, message: 'Senha atual é obrigatória para alterações.' });
            }

            // 3. Preparar campos de atualização
            let passwordHash = admin.password_hash;
            if (new_password) {
                if (new_password.length < 6) {
                    return res.status(400).json({ success: false, message: 'Nova senha deve ter no mínimo 6 caracteres.' });
                }
                passwordHash = await bcrypt.hash(new_password, 12);
            }

            const targetEmail = email || admin.email;

            // 4. Executar Update no Banco Global
            await globalDb.run(
                'UPDATE admins SET email = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [targetEmail, passwordHash, adminId]
            );

            logger.info(`[AdminAudit] ${admin.email} | PERFIL ATUALIZADO (Novo Email: ${targetEmail}) | ${new Date().toISOString()}`);

            return res.json({
                success: true,
                message: 'Perfil atualizado com sucesso.',
                admin: { id: adminId, email: targetEmail, role: admin.role }
            });

        } catch (error) {
            if (error.message.includes('UNIQUE constraint failed')) {
                return res.status(409).json({ success: false, message: 'Este e-mail já está em uso por outro administrador.' });
            }
            logger.error(`[AdminAudit] Erro ao atualizar perfil admin: ${error.message}`);
            return res.status(500).json({ success: false, message: 'Erro ao processar atualização de perfil.' });
        }
    }
}

export default new AdminAuthController();

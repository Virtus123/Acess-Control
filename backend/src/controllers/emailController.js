import { getTenantDatabase } from '../middleware/tenantManager.js';
import emailService from '../services/emailService.js';

class EmailController {
    /**
     * List email logs with pagination and search
     */
    async listEmails(req, res) {
        try {
            const { tenant_id, limit = 50, page = 1, status, search } = req.query;
            
            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetro obrigatório: tenant_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            const offset = (parseInt(page) - 1) * parseInt(limit);
            
            let query = `SELECT * FROM email_logs WHERE 1=1`;
            const params = [];
            
            if (status) {
                query += ` AND status = ?`;
                params.push(status);
            }
            
            if (search) {
                query += ` AND (to_address LIKE ? OR subject LIKE ? OR body LIKE ?)`;
                const searchParam = `%${search}%`;
                params.push(searchParam, searchParam, searchParam);
            }
            
            // Get total count for pagination
            const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
            const { total } = await db.get(countQuery, params);
            
            query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            params.push(parseInt(limit), offset);
            
            const emails = await db.all(query, params);
            
            return res.json({
                success: true,
                data: emails,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil(total / parseInt(limit))
                }
            });
            
        } catch (error) {
            console.error('Error listing emails:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao listar emails: ' + error.message
            });
        }
    }

    /**
     * Resend an email from the log
     */
    async resendEmail(req, res) {
        try {
            const { tenant_id, log_id } = req.body;
            
            if (!tenant_id || !log_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parâmetros obrigatórios: tenant_id, log_id'
                });
            }
            
            const db = await getTenantDatabase(tenant_id);
            
            const log = await db.get(
                `SELECT * FROM email_logs WHERE id = ?`,
                [log_id]
            );
            
            if (!log) {
                return res.status(404).json({
                    success: false,
                    message: 'Log de email não encontrado'
                });
            }
            
            // Re-enqueue using EmailService
            const result = emailService.enviarEmail({
                para: log.to_address,
                assunto: log.subject,
                corpo: log.body,
                cc: log.cc,
                tenantId: tenant_id
            });
            
            return res.json({
                success: true,
                message: 'Email reenviado para a fila',
                jobId: result.jobId
            });
            
        } catch (error) {
            console.error('Error resending email:', error);
            return res.status(500).json({
                success: false,
                message: 'Erro ao reenviar email: ' + error.message
            });
        }
    }
}

export default new EmailController();

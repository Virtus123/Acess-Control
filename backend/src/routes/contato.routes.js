import express from 'express';
import { Resend } from 'resend';
import logger from '../config/logger.js';

const router = express.Router();

// Função para obter instância do Resend
function getResend() {
    return new Resend(process.env.RESEND_API_KEY);
}

function gerarProtocolo() {
    const data = new Date();
    const ano = data.getFullYear().toString().slice(-2);
    const mes = (data.getMonth() + 1).toString().padStart(2, '0');
    const dia = data.getDate().toString().padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `#SUP-${ano}${mes}${dia}-${random}`;
}

router.post('/', async (req, res) => {
    const { nome, email, cnpj, celular, motivo } = req.body;
    const protocolo = gerarProtocolo();
    
    // Validar campos obrigatórios
    if (!nome || !email || !celular || !motivo) {
        return res.status(400).json({
            success: false,
            message: 'Preencha todos os campos obrigatórios'
        });
    }
    
    // Validar email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({
            success: false,
            message: 'Email inválido'
        });
    }
    
    try {
        // Verificar se a API key está configurada
        if (!process.env.RESEND_API_KEY) {
            logger.error('RESEND_API_KEY não configurada');
            return res.status(500).json({
                success: false,
                message: 'Erro de configuração do servidor'
            });
        }
        
        const resend = getResend();
        
        // 📩 EMAIL 1 — PRA VOCÊ (suporte)
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: 'vitorfernandes.y02@gmail.com',
            subject: `Novo contato - ${protocolo}`,
            html: `
                <h2>Novo contato recebido</h2>
                <p><strong>Protocolo:</strong> ${protocolo}</p>
                <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
                
                <h3>Dados do solicitante:</h3>
                <p><strong>Nome:</strong> ${nome}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>CNPJ:</strong> ${cnpj || 'Não informado'}</p>
                <p><strong>Celular:</strong> ${celular}</p>
                
                <h3>Motivo do contato:</h3>
                <p>${motivo.replace(/\n/g, '<br>')}</p>
                
                <hr>
                <p style="color: #666; font-size: 12px;">
                    Este é um email automático. Por favor, não responda.
                </p>
            `
        });
        
        // 📩 EMAIL 2 — CONFIRMAÇÃO PRA CLIENTE
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email,
            subject: 'Recebemos seu contato ✔️',
            html: `
                <h2>Olá, ${nome}!</h2>
                
                <p>Recebemos sua solicitação de contato com sucesso.</p>
                
                <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p><strong>Protocolo:</strong> ${protocolo}</p>
                    <p><strong>Data/Hora:</strong> ${new Date().toLocaleString('pt-BR')}</p>
                    <p><strong>Motivo:</strong> ${motivo}</p>
                </div>
                
                <p>Nossa equipe de suporte analisará sua solicitação e retornará o contato em até 24 horas úteis.</p>
                
                <p>Para acompanhar o status da sua solicitação, guarde o número de protocolo acima.</p>
                
                <hr>
                
                <p style="color: #666; font-size: 14px;">
                    <strong>Acess Control</strong><br>
                    Sistema de Controle de Acesso
                </p>
                
                <p style="color: #999; font-size: 12px;">
                    Este é um email automático. Por favor, não responda.
                </p>
            `
        });
        
        logger.info(`Contato enviado com protocolo: ${protocolo}`);
        
        res.json({
            success: true,
            protocolo,
            message: 'Contato enviado com sucesso'
        });
        
    } catch (error) {
        logger.error('Erro ao enviar contato:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao processar solicitação'
        });
    }
});

export default router;

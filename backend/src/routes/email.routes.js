import express from 'express';
import emailController from '../controllers/emailController.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Emails
 *   description: Monitoramento e controle de emails enviados
 */

/**
 * @swagger
 * /emails:
 *   get:
 *     summary: Lista o histórico de emails enviados
 *     tags: [Emails]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de emails retornada com sucesso
 */
router.get('/', emailController.listEmails);

/**
 * @swagger
 * /emails/resend:
 *   post:
 *     summary: Reenvia um email da fila
 *     tags: [Emails]
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Email reenviado com sucesso
 */
router.post('/resend', emailController.resendEmail);

export default router;

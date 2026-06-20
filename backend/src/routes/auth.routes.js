import express from 'express';
import { login, loginMobile, refresh, logout, me, register, getUsers, getUser, updateUser, deleteUser } from '../controllers/authController.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Autenticação e gerenciamento de usuários
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Realiza o login do usuário (Início de sessão)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Login realizado com sucesso e retorna o token JWT
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Credenciais inválidas
 */
router.post('/login', login);


/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Atualiza o token de acesso
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Token atualizado com sucesso
 */
router.post('/refresh', refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Realiza o logout do usuário
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Logout realizado com sucesso
 */
router.post('/logout', logout);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Obtém os dados do usuário autenticado
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Dados do usuário retornados com sucesso
 *       401:
 *         description: Não autorizado
 */
router.get('/me', authenticate, me);

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Registra um novo usuário (Apenas Admin)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [admin, user, operator]
 *     responses:
 *       201:
 *         description: Usuário criado com sucesso
 */
router.post('/register', authenticate, requireRole('admin'), register);

/**
 * @swagger
 * /auth/users:
 *   get:
 *     summary: Lista todos os usuários (Apenas Admin)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     responses:
 *       200:
 *         description: Lista de usuários retornada com sucesso
 */
router.get('/users', authenticate, requireRole('admin'), getUsers);

/**
 * @swagger
 * /auth/users/{id}:
 *   get:
 *     summary: Obtém detalhes de um usuário específico (Apenas Admin)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Usuário encontrado
 */
router.get('/users/:id', authenticate, requireRole('admin'), getUser);

/**
 * @swagger
 * /auth/users/{id}:
 *   put:
 *     summary: Atualiza um usuário (Apenas Admin)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Usuário atualizado com sucesso
 */
router.put('/users/:id', authenticate, requireRole('admin'), updateUser);

/**
 * @swagger
 * /auth/users/{id}:
 *   delete:
 *     summary: Exclui um usuário (Apenas Admin)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *         bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Usuário excluído com sucesso
 */
router.delete('/users/:id', authenticate, requireRole('admin'), deleteUser);

/**
 * @swagger
 * /auth/login-mobile:
 *   post:
 *     summary: Realiza o login para o aplicativo mobile (CPF + Tenant ID)
 *     tags: [Auth]
 *     security:
 *       - tenantId: []
 *     parameters:
 *       - $ref: '#/components/parameters/tenantIdHeader'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - cpf
 *             properties:
 *               cpf:
 *                 type: string
 *                 description: CPF do usuário (apenas números ou formatado)
 *                 example: "123.456.789-00"
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: CPF não encontrado ou inativo para este tenant
 *       400:
 *         description: CPF ou Tenant ID ausente
 */
router.post('/login-mobile', loginMobile);

export default router;




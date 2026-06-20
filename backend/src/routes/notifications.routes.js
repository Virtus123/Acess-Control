import express from 'express';
import * as notificationController from '../controllers/notificationController.js';

const router = express.Router();

// Rotas públicas (para todos os tenants)
router.get('/', notificationController.listNotifications);
router.get('/count', notificationController.countNotifications);
router.get('/unread-prioritary', notificationController.listUnreadPrioritary);
router.post('/:id/read', notificationController.markAsRead);

// Rotas admin (protegidas - precisam de autenticação de admin master)
router.post('/', notificationController.createNotification);
router.put('/:id', notificationController.updateNotification);
router.delete('/:id', notificationController.deleteNotification);
router.get('/all', notificationController.listAllNotifications);

export default router;

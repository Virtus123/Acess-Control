import express from 'express';
import * as notificacoesController from '../controllers/notificacoesController.js';

const router = express.Router();

router.get('/', notificacoesController.listar);
router.post('/', notificacoesController.criar);
router.get('/:id', notificacoesController.buscarNotificacao);
router.put('/:id', notificacoesController.editar);
router.patch('/:id/toggle', notificacoesController.toggleNotificacao);
router.delete('/:id', notificacoesController.excluir);

export default router;

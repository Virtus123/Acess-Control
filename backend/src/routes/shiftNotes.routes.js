import { Router } from 'express';
import * as shiftNotesController from '../controllers/shiftNotesController.js';
import { authenticate } from '../middleware/auth.js';
import { noteAttachmentUpload } from '../config/noteAttachmentUpload.js';

const router = Router();

// Attachment routes (must come before /:id to avoid conflicts)
router.get('/attachments/:attachmentId/view', authenticate, shiftNotesController.viewAttachment);
router.get('/attachments/:attachmentId/download', authenticate, shiftNotesController.downloadAttachment);
router.delete('/attachments/:attachmentId', authenticate, shiftNotesController.deleteAttachment);

// Note CRUD
router.get('/', authenticate, shiftNotesController.list);
router.post('/', authenticate, shiftNotesController.create);
router.put('/:id', authenticate, shiftNotesController.update);
router.delete('/:id', authenticate, shiftNotesController.remove);

// Note attachments
router.get('/:id/attachments', authenticate, shiftNotesController.listAttachments);
router.post('/:id/attachments', authenticate, noteAttachmentUpload.single('file'), shiftNotesController.uploadAttachment);

export default router;

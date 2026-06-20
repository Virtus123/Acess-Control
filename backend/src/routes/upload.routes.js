import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { upload } from '../config/upload.js';

const router = express.Router();

router.use(authenticate);

router.post('/photo', upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Arquivo não enviado'
    });
  }

  const type = req.body.type || 'person';
  res.json({
    success: true,
    data: {
      filename: req.file.filename,
      url: `/uploads/photos/${type}/${req.file.filename}`,
      size: req.file.size
    }
  });
});

export default router;


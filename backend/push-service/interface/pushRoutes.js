// Rotas que o EQUIPAMENTO chama. NÃO mudar formato sem validar com PUSH.txt.
//
// GET  /api/push          → equipamento pede comando (long-poll até 25s)
// POST /api/push/result   → equipamento devolve resultado

import express from 'express';
import { authenticateDevice } from '../infrastructure/deviceAuth.js';
import { executePoll } from '../application/pollUseCase.js';
import { executeResult } from '../application/resultUseCase.js';
import { touchDeviceLastSeen } from '../infrastructure/outboxRepo.js';
import logger from '../infrastructure/logger.js';

const router = express.Router();

// JSON parser dedicado (limite alto para fotos em base64)
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true, limit: '10mb' }));

// GET /api/push?deviceId=...&uuid=...
router.get('/', async (req, res) => {
  try {
    const auth = await authenticateDevice(req);
    if (!auth) {
      return res.status(401).send();
    }

    touchDeviceLastSeen(auth.tenantId, auth.deviceId).catch(() => {});

    const uuid = req.query.uuid || `srv-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

    const payload = await executePoll(auth, uuid);

    if (!payload) {
      // Resposta vazia conforme spec Control iD (PUSH.txt item 6)
      return res.status(200).send();
    }

    res.status(200).json(payload);
  } catch (err) {
    logger.error('push_get_failed', {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    res.status(200).send(); // não joga 500 — equipamento ficaria em loop
  }
});

// POST /api/push/result — alias compatível com clientes que mandam aqui
router.post('/result', handleResult);

export async function handleResult(req, res) {
  try {
    const auth = await authenticateDevice(req);
    if (!auth) {
      return res.status(401).send();
    }

    // Firmware Control iD manda deviceId/uuid/endpoint via QUERY STRING
    // (não no body). Mesclamos query+body para o use case ficar agnóstico.
    const merged = {
      deviceId: req.query.deviceId || req.body?.deviceId,
      uuid:     req.query.uuid     || req.body?.uuid,
      endpoint: req.query.endpoint || req.body?.endpoint,
      ...(req.body || {}),
    };

    await executeResult(auth, merged);

    // Resposta deve ser vazia conforme PUSH.txt item 10
    res.status(200).json({});
  } catch (err) {
    logger.error('push_result_failed', {
      error: err.message,
      stack: err.stack,
      query: req.query,
      body: JSON.stringify(req.body).slice(0, 500),
    });
    res.status(200).json({}); // mesmo erro, responde vazio
  }
}

export default router;

// Autorização online — equipamento chama a cada identificação síncrona.
// Esta rota REQUER o autorizadorService do backend antigo. Caminho relativo
// configurado via env (default assume backend/ ao lado de push-service/).
//
// Em desenvolvimento, ajustar AUTHORIZER_PATH conforme estrutura local.

import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve, isAbsolute } from 'path';
import { authenticateDevice } from '../infrastructure/deviceAuth.js';
import { classifyDeviceUserId } from '../domain/deviceUserId.js';
import { getTenantDb } from '../infrastructure/tenantDb.js';
import { touchDeviceLastSeen } from '../infrastructure/outboxRepo.js';
import { setAcessoPendente } from '../infrastructure/acessosPendentes.js';
import logger from '../infrastructure/logger.js';

const router = express.Router();

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path do autorizadorService do backend antigo.
// Default resolve para backend/src/services/autorizadorService.js
// (este arquivo: backend/push-service/interface/onlineRoutes.js → sobe 3 níveis)
const AUTHORIZER_PATH = process.env.AUTHORIZER_PATH
  || resolve(__dirname, '..', '..', 'src', 'services', 'autorizadorService.js');

let processarAcesso = null;

// Lazy import — não trava startup se path estiver errado
async function getAuthorizer() {
  if (processarAcesso) return processarAcesso;
  try {
    // ESM no Windows exige file:// URL em import dinâmico com path absoluto
    const absolutePath = isAbsolute(AUTHORIZER_PATH)
      ? AUTHORIZER_PATH
      : resolve(__dirname, AUTHORIZER_PATH);
    const moduleUrl = pathToFileURL(absolutePath).href;

    const mod = await import(moduleUrl);
    processarAcesso = mod.processarAcesso || mod.default?.processarAcesso;
    if (!processarAcesso) {
      throw new Error(`módulo importado mas processarAcesso não encontrado em ${absolutePath}`);
    }
    logger.info('authorizer_loaded', { path: absolutePath });
    return processarAcesso;
  } catch (err) {
    logger.error('authorizer_load_failed', { error: err.message, path: AUTHORIZER_PATH });
    throw err;
  }
}

router.use(express.json({ limit: '1mb' }));
router.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Handler reaproveitável (montado em /api/online/new_user_identified
// E também em /new_user_identified.fcgi na raiz — formato esperado pela firmware)
export async function handleNewUserIdentified(req, res) {
  try {
    const auth = await authenticateDevice(req);
    if (!auth) return res.status(401).send();

    const data = { ...req.body, ...req.query };
    let deviceUserId = parseInt(data.user_id, 10) || 0;
    const portalId = parseInt(data.portal_id, 10) || 1;
    const cardType = parseInt(data.card_type, 10);
    const cardValue = data.card_value;

    // Integração UHF: user_id vem 0, mas temos card_type = 1 e card_value (EPC da tag)
    if (deviceUserId === 0 && cardType === 1 && cardValue) {
      try {
        const db = await getTenantDb(auth.tenantId);
        const vehicle = await db.get(
          'SELECT person_id FROM vehicles WHERE uhf_tag = ? OR uhf_tag = ?',
          [String(cardValue), String(cardValue).replace(',', '')]
        );
        if (vehicle && vehicle.person_id) {
          const person = await db.get('SELECT registration_number FROM persons WHERE id = ?', [vehicle.person_id]);
          if (person && person.registration_number) {
            deviceUserId = parseInt(person.registration_number, 10);
            logger.info('uhf_tag_resolved', { cardValue, personId: vehicle.person_id, deviceUserId });
          }
        }
      } catch (err) {
        logger.error('uhf_lookup_failed', { error: err.message, cardValue });
      }
    }

    if (deviceUserId === 0) {
      return res.json({
        result: {
          event: 3,
          user_id: 0,
          user_name: '',
          user_image: false,
          portal_id: portalId,
          actions: [],
        },
      });
    }

    // PRODUÇÃO: id no equipamento = MATRÍCULA. Autorizador busca por
    // registration_number naturalmente — passa o valor direto, igual o
    // Comunicador legado faz há anos.
    //
    // EXCEÇÃO: visitor sem matrícula recebeu id+OFFSET na hora de cadastrar.
    // Aqui mapeamos de volta pra (type='visitor', id=interno) — autorizador
    // acha pelo lookup secundário por persons/visitors.id.
    let authIdentifier = String(deviceUserId);
    let personType;
    const classified = classifyDeviceUserId(deviceUserId);
    if (classified.isVisitorFallback) {
      authIdentifier = String(classified.visitorInternalId);
      personType = 'visitor';
    }

    logger.info('new_user_identified', {
      deviceId: auth.deviceId, tenantId: auth.tenantId,
      deviceUserId, authIdentifier, personType: personType || '(auto)',
      portalId, userName: data.user_name || '',
    });

    const authorizer = await getAuthorizer();
    const result = await authorizer(auth.tenantId, auth.deviceId, authIdentifier, personType);

    const response = buildAuthorizationResponse({
      data, result, userId: deviceUserId, portalId,  // devolve ao equipamento o ID que ele mandou
      modelo: auth.equipment?.modelo || 'iDFace',
    });

    // IDBlock (catraca): guarda pending pra catra_event recuperar o user_id
    // quando equip notificar o giro físico. Sem isso, /catra_event não tem
    // como saber QUEM foi a pessoa que girou (firmware não manda user_id lá).
    const modeloLower = (auth.equipment?.modelo || '').toLowerCase();
    const isCatra = modeloLower.includes('idblock');
    const allowed = !!(result?.allowed || result?.status);
    if (isCatra && allowed) {
      setAcessoPendente(auth.tenantId, auth.deviceId, deviceUserId);
    }

    logger.info('authorization_decision', {
      deviceId: auth.deviceId,
      userId: deviceUserId,
      allowed,
      message: result?.message,
      event: response?.result?.event,
      actions: response?.result?.actions,
      pendingForCatra: isCatra && allowed,
    });

    res.json(response);
  } catch (err) {
    logger.error('online_failed', {
      error: err.message,
      stack: err.stack,
      body: JSON.stringify(req.body).slice(0, 300),
    });
    // Fallback: nega acesso por segurança
    res.json({
      result: {
        event: 6,
        user_id: parseInt(req.body?.user_id, 10) || 0,
        user_name: '',
        user_image: false,
        portal_id: 1,
        actions: [],
      },
    });
  }
}

router.post('/new_user_identified', handleNewUserIdentified);

// Heartbeat opcional — equipamento chama device_is_alive (alguns FWs).
router.post('/device_is_alive', async (req, res) => {
  const auth = await authenticateDevice(req);
  if (!auth) return res.status(401).send();
  touchDeviceLastSeen(auth.tenantId, auth.deviceId).catch(() => {});
  res.json({ status: 0 });
});

router.post('/session_is_valid', (req, res) => {
  res.json({ status: 0 });
});

router.post('/notifications', (req, res) => {
  // Probe — só retorna 0
  res.json({ status: 0 });
});

function buildAuthorizationResponse({ data, result, userId, portalId, modelo }) {
  const isCatra = /idblock/i.test(modelo);
  const userImage = data.user_has_image === '1' || data.user_has_image === 1;

  // Acesso liberado
  if (result?.allowed === true || result?.status === true) {
    const action = isCatra
      ? { action: 'catra', parameters: 'allow=both' }
      : { action: 'sec_box', parameters: 'id=65793,reason=3' };
    return {
      result: {
        event: 7,
        user_id: userId,
        user_name: data.user_name || '',
        user_image: userImage,
        portal_id: portalId,
        actions: [action],
      },
    };
  }

  // Acesso negado
  return {
    result: {
      event: 6,
      user_id: userId,
      user_name: data.user_name || '',
      user_image: userImage,
      portal_id: portalId,
      actions: [],
    },
  };
}

export default router;

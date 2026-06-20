/**
 * UHF Controller — Integração com equipamentos IDUHF
 *
 * Recebe eventos de leitura de tag UHF vindos do Equipment Bridge,
 * identifica o veículo pela tag, e aciona o autorizador de acesso.
 *
 * Endpoint: POST /api/comunicador/uhf
 * Público — sem autenticação JWT (mesma política dos outros endpoints do comunicador)
 */

import dbManager from '../config/database.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { processarAcesso } from '../services/autorizadorService.js';

// Cache de idempotência: uuid → { result, expires }
// Evita duplo processamento caso o equipamento reenvie o mesmo evento
const uhfEventCache = new Map();
const UHF_CACHE_TTL_MS = 30_000; // 30 segundos

/**
 * Normaliza a tag UHF para o formato padrão "A,B" (ex: "123,4567").
 * Suporta entrada nos formatos: padrão, decimal puro e hexadecimal.
 */
function normalizeUhfTag(raw) {
  const tag = String(raw).trim();

  // Já está no formato padrão: "123,4567"
  if (/^\d+,\d+$/.test(tag)) return tag;

  // Decimal puro: "1234567" → "123,4567"
  if (/^\d+$/.test(tag)) {
    const num = parseInt(tag, 10);
    const high = Math.floor(num / 10000);
    const low = num % 10000;
    return `${high},${low.toString().padStart(4, '0')}`;
  }

  // Hexadecimal: "0x1E2407" ou "1E2407" → "123,4567"
  const hexMatch = tag.match(/^(?:0x)?([0-9A-Fa-f]+)$/i);
  if (hexMatch) {
    const num = parseInt(hexMatch[1], 16);
    const high = Math.floor(num / 10000);
    const low = num % 10000;
    return `${high},${low.toString().padStart(4, '0')}`;
  }

  // Formato desconhecido — retorna original para não bloquear
  return tag;
}

/**
 * Gera todas as variantes de busca de uma tag já normalizada.
 * Garante que tags cadastradas em um formato sejam encontradas
 * mesmo que o equipamento envie em outro.
 */
function getAllTagVariants(normalizedTag) {
  const variants = new Set([normalizedTag]);

  const padrao = normalizedTag.match(/^(\d+),(\d+)$/);
  if (padrao) {
    const num = parseInt(padrao[1], 10) * 10000 + parseInt(padrao[2], 10);
    variants.add(String(num));                              // decimal puro
    variants.add(num.toString(16).toUpperCase());           // hex sem prefixo
    variants.add('0x' + num.toString(16).toUpperCase());   // hex com 0x
  }

  return [...variants];
}

/**
 * POST /api/comunicador/uhf
 *
 * Body esperado (enviado pelo Equipment Bridge):
 *   tenant_id       — ID do tenant
 *   equip_validator — validador do equipamento cadastrado no NEXIS
 *   uhf_tag         — tag UHF lida (qualquer formato)
 *   device_id       — ID físico do equipamento IDUHF (para log)
 *   uuid            — identificador único do evento (idempotência)
 *   time            — timestamp Unix do evento
 *   portal_id       — ID do portal (para log)
 */
export const receiveUhfTag = asyncHandler(async (req, res) => {
  const {
    tenant_id,
    equip_validator,
    uhf_tag,
    device_id,
    uuid,
    time: eventTime,
    portal_id
  } = req.body;

  // Validação de campos obrigatórios
  if (!tenant_id || !equip_validator || !uhf_tag) {
    return res.status(400).json({
      success: false,
      message: 'Parâmetros obrigatórios: tenant_id, equip_validator, uhf_tag'
    });
  }

  // Idempotência: se o mesmo uuid já foi processado, retorna o resultado cacheado
  if (uuid && uhfEventCache.has(uuid)) {
    console.log(`[UHF] Evento duplicado ignorado: uuid=${uuid}`);
    return res.json(uhfEventCache.get(uuid).result);
  }

  console.log(`\n=== AUTORIZAÇÃO UHF ===`);
  console.log(`Tag: ${uhf_tag} | Equip: ${equip_validator} | Tenant: ${tenant_id}`);

  try {
    const normalizedTag = normalizeUhfTag(uhf_tag);
    const tagVariants = getAllTagVariants(normalizedTag);

    const db = await dbManager.getConnection(tenant_id);

    // Buscar veículo pela tag, tentando todas as variantes de formato
    let vehicle = null;
    for (const variant of tagVariants) {
      vehicle = await db.get(
        `SELECT v.id, v.plate, v.model, v.color, v.status, v.company_id,
                v.person_id, p.registration_number
         FROM vehicles v
         JOIN persons p ON p.id = v.person_id
         WHERE (v.uhf_tag = ? OR v.tag_number = ?)
           AND (v.status IS NULL OR v.status != 'deleted')
         LIMIT 1`,
        [variant, variant]
      );
      if (vehicle) break;
    }

    if (!vehicle) {
      console.log(`[UHF] Tag não encontrada: ${uhf_tag} (normalizada: ${normalizedTag})`);
      const result = {
        success: false,
        status: false,
        message: 'Veículo não encontrado para esta tag UHF'
      };
      _cacheResult(uuid, result);
      return res.json(result);
    }

    console.log(`[UHF] Veículo: ${vehicle.plate} (id=${vehicle.id}) | Matrícula: ${vehicle.registration_number}`);

    // Acionar o autorizador com a matrícula da pessoa + vehicleId pré-resolvido
    // O autorizador usará vehicleId para selecionar exatamente este veículo,
    // garantindo comportamento correto mesmo para pessoas com múltiplos carros.
    const authResult = await processarAcesso(
      tenant_id,
      equip_validator,
      vehicle.registration_number,
      'person',
      { vehicleId: vehicle.id, uhfTag: normalizedTag, source: 'uhf' }
    );

    const response = {
      success: true,
      status: authResult.allowed,
      message: authResult.message,
      data: {
        ...authResult.data,
        vehicle: {
          id: vehicle.id,
          plate: vehicle.plate,
          model: vehicle.model
        },
        uhf_tag: normalizedTag
      }
    };

    _cacheResult(uuid, response);

    console.log(`[UHF] ${authResult.allowed ? '✅ LIBERADO' : '❌ NEGADO'} — ${authResult.message}`);
    console.log('======================\n');

    return res.json(response);

  } catch (error) {
    console.error(`[UHF] Erro ao processar tag ${uhf_tag}:`, error.message);
    return res.status(500).json({
      success: false,
      status: false,
      message: 'Erro interno ao processar tag UHF'
    });
  }
});

function _cacheResult(uuid, result) {
  if (!uuid) return;
  uhfEventCache.set(uuid, { result, expires: Date.now() + UHF_CACHE_TTL_MS });
  setTimeout(() => uhfEventCache.delete(uuid), UHF_CACHE_TTL_MS);
}

/**
 * Configurações de autenticação e segurança centralizadas
 */
export const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
export const SIGNED_URL_EXPIRES_IN = '1h'; // Duração padrão do link de foto no frontend
export const COMMUNICATOR_LINK_EXPIRES_IN = '24h'; // Duração estendida para o hardware

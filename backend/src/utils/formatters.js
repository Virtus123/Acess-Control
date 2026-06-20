import photoService from '../services/photoService.js';

export function formatPerson(person) {
  if (!person) return null;

  // Gerar URL assinada se houver foto
  let photoUrl = person.photo_url;
  if (photoUrl && !photoUrl.includes('token=')) {
    photoUrl = photoService.generateSignedUrl(photoUrl, 'person', '1h');
  }

  // Converter nome para caixa alta
  const name = person.name ? person.name.toUpperCase() : null;
  const socialName = person.social_name ? person.social_name.toUpperCase() : null;
  const registryName = person.registry_name ? person.registry_name.toUpperCase() : null;

  // Formatar permissões mobile
  let mobilePermissions = null;
  if (person.mobile_permissions) {
    try {
      mobilePermissions = typeof person.mobile_permissions === 'string' ? JSON.parse(person.mobile_permissions) : person.mobile_permissions;
    } catch (e) {
      mobilePermissions = ['equipments', 'encomendas', 'monitoramento'];
    }
  }

  return {
    ...person,
    photo_url: photoUrl,
    name: name,
    social_name: socialName,
    registry_name: registryName,
    lgpd_consent: Boolean(person.lgpd_consent),
    consent_date: person.consent_date || null,
    birth_date: person.birth_date || null,
    admission_date: person.admission_date || null,
    mobile_permissions: mobilePermissions,
    created_at: person.created_at,
    updated_at: person.updated_at
  };
}

export function formatVisitor(visitor) {
  if (!visitor) return null;

  // Gerar URL assinada se houver foto
  let photoUrl = visitor.photo_url;
  if (photoUrl && !photoUrl.includes('token=')) {
    photoUrl = photoService.generateSignedUrl(photoUrl, 'visitor', '1h');
  }

  // Converter nome para caixa alta
  const name = visitor.name ? visitor.name.toUpperCase() : null;

  return {
    ...visitor,
    photo_url: photoUrl,
    name: name,
    entry_date: visitor.entry_date,
    exit_date: visitor.exit_date || null,
    created_at: visitor.created_at
  };
}

export function formatCompany(company) {
  if (!company) return null;

  // Converter nomes para caixa alta
  const corporateName = company.corporate_name ? company.corporate_name.toUpperCase() : null;
  const tradingName = company.trading_name ? company.trading_name.toUpperCase() : null;

  return {
    ...company,
    corporate_name: corporateName,
    trading_name: tradingName,
    active: Boolean(company.active),
    created_at: company.created_at
  };
}

export function formatGroup(group) {
  if (!group) return null;
  
  return {
    ...group,
    active: Boolean(group.active),
    created_at: group.created_at
  };
}

export function formatUser(user) {
  if (!user) return null;

  // Remover TODOS os campos sensíveis
  const sensitiveFields = [
    'password_hash', 
    'permissions', 
    'last_login',
    'password_reset_token',
    'password_reset_expires'
  ];
  
  const userWithoutSensitive = { ...user };
  sensitiveFields.forEach(field => {
    delete userWithoutSensitive[field];
  });
  
  return {
    ...userWithoutSensitive,
    active: Boolean(user.active)
  };
}

/**
 * Formatar dados de pessoa removendo informações sensíveis (LGPD)
 * CPF, RG, dados bancários não devem ser expostos na API
 */
export function formatPersonData(person) {
  if (!person) return null;
  
  // Campos sensíveis que NÃO devem ser expostos na API
  const sensitiveFields = [
    'bankAccount',
    'bankBranch',
    'bankAccountDigit',
    'political_function',
    'political_position',
    'password_hash'
  ];
  
  const personData = { ...person };
  sensitiveFields.forEach(field => {
    // Remover completamente campos sensíveis
    delete personData[field];
  });

  // Base64 legado não deve ir para o front (listagem usava foto antiga do banco)
  delete personData.photo_base64;
  
  return personData;
}

export function paginate(query, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  return {
    query: `${query} LIMIT ? OFFSET ?`,
    params: [limit, offset]
  };
}




import { asyncHandler } from '../middleware/errorHandler.js';
import auditService from '../services/auditService.js';

export const getLabels = asyncHandler(async (req, res) => {
  const db = req.db;

  const configs = await db.all(
    "SELECT * FROM system_config WHERE config_key LIKE 'label_%'"
  );

  const labels = {};
  configs.forEach(config => {
    const key = config.config_key.replace('label_', '');
    labels[key] = config.config_value;
  });

  res.json({
    success: true,
    data: labels
  });
});

export const updateLabels = asyncHandler(async (req, res) => {
  const db = req.db;
  const labels = req.body;

  for (const [key, value] of Object.entries(labels)) {
    await db.run(
      `INSERT OR REPLACE INTO system_config (config_key, config_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
      [`label_${key}`, value, new Date().toISOString(), req.user.id]
    );
  }

  res.json({
    success: true,
    message: 'Labels atualizadas com sucesso'
  });

  // Log audit
  await auditService.logAction({
      req,
      action: 'UPDATE',
      entity_type: 'system_config',
      description: 'Atualização de labels do sistema',
      new_values: labels
  });
});

export const getSystemConfig = asyncHandler(async (req, res) => {
  const db = req.db;

  const configs = await db.all('SELECT * FROM system_config');

  const config = {};
  configs.forEach(c => {
    config[c.config_key] = {
      value: c.config_value,
      description: c.description
    };
  });

  res.json({
    success: true,
    data: config
  });
});

export const updateSystemConfig = asyncHandler(async (req, res) => {
  const db = req.db;
  const { config_key, config_value, description } = req.body;

  if (!config_key) {
    return res.status(400).json({
      success: false,
      message: 'Chave de configuração é obrigatória'
    });
  }

  await db.run(
    `INSERT OR REPLACE INTO system_config (config_key, config_value, description, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?)`,
    [config_key, config_value, description || null, new Date().toISOString(), req.user.id]
  );

  res.json({
    success: true,
    message: 'Configuração atualizada com sucesso'
  });

  // Log audit
  await auditService.logAction({
      req,
      action: 'UPDATE',
      entity_type: 'system_config',
      entity_id: config_key,
      description: `Atualização de configuração: ${config_key}`,
      new_values: { [config_key]: config_value }
  });
});

export const getLGPDConfig = asyncHandler(async (req, res) => {
  const db = req.db;

  const consentCount = await db.get(
    "SELECT COUNT(*) as count FROM persons WHERE lgpd_consent = 1"
  );

  const totalPersons = await db.get("SELECT COUNT(*) as count FROM persons");

  res.json({
    success: true,
    data: {
      total_persons: totalPersons.count,
      consent_count: consentCount.count,
      consent_percentage: totalPersons.count > 0 
        ? ((consentCount.count / totalPersons.count) * 100).toFixed(2)
        : 0
    }
  });
});

export const getModules = asyncHandler(async (req, res) => {
  const db = req.db;
  const tenantId = req.tenantId;
  
  console.log('Buscando módulos para tenantId:', tenantId);

  const configs = await db.all(
    "SELECT * FROM system_config WHERE config_key LIKE 'module_%' OR config_key IN ('lookup_id_primeiro', 'font_size', 'reset_estatisticas_diario')"
  );

  console.log('Configurações encontradas no banco:', configs);
  
  const modules = {};
  
  // Define default values for all modules
  const defaultModules = {
    // Cadastro - Campos
    module_cadastro_celular: 'true',
    module_cadastro_cartao: 'true',
    module_cadastro_grupo: 'true',
    module_cadastro_empresa: 'true',
    module_cadastro_pessoa_visitada: 'true',
    // Cadastro - Submenus
    module_cadastro_refeitorio: 'false',
    module_cadastro_encomendas: 'true',
    module_cadastro_claviculario: 'false',
    module_cadastro_estacionamento: 'false',
    module_cadastro_veiculos: 'false',
    // Autorização - Submenus
    module_autorizacao_refeicao: 'false',
    module_autorizacao_claviculario: 'false',
    module_autorizacao_nivel_acesso_veiculos: 'false',
    module_autorizacao_acesso_veiculos: 'false',
    // Outros módulos
    module_pessoas: 'true',
    module_visitantes: 'true',
    module_veiculos: 'true',
    module_empresas: 'true',
    module_horarios: 'true',
    module_feriados: 'true',
    module_estacionamento: 'false',
    module_equipamentos: 'true',
    // Limpeza automática
    module_inativar_visitantes_dia: 'false',
    // Validação de acesso
    lookup_id_primeiro: 'false',
    // Aparência
    font_size: 'normal'
  };

  // Start with defaults
  Object.assign(modules, defaultModules);
  
  // Override with stored values
  if (configs && Array.isArray(configs)) {
    configs.forEach(config => {
      // Use the stored value, whatever it is ('true' or 'false')
      modules[config.config_key] = config.config_value;
    });
  }

  // PASSO 5: Adicionar leitura da tenant_config para notif_visitante_entrada_email e notif_encomenda_email
  try {
    const flagVisitante = await db.get(
      "SELECT value FROM tenant_config WHERE key = 'notif_visitante_entrada_email'"
    );
    modules.notif_visitante_entrada_email = flagVisitante ? flagVisitante.value === 'true' : false;

    const flagEncomenda = await db.get(
      "SELECT value FROM tenant_config WHERE key = 'notif_encomenda_email'"
    );
    modules.notif_encomenda_email = flagEncomenda ? flagEncomenda.value === 'true' : false;
  } catch (err) {
    logger.warn('Erro ao ler tenant_config para flags de notificação:', err.message);
    modules.notif_visitante_entrada_email = modules.notif_visitante_entrada_email || false;
    modules.notif_encomenda_email = modules.notif_encomenda_email || false;
  }

  console.log('Módulos finais:', modules);
  
  res.json({
    success: true,
    data: modules
  });
});

export const updateModules = asyncHandler(async (req, res) => {
  const db = req.db;
  const modules = req.body;

  for (const [key, value] of Object.entries(modules)) {
    // Se for flag de notificação de e-mail (visitante ou encomenda), salvar na tenant_config
    if (key === 'notif_visitante_entrada_email' || key === 'notif_encomenda_email') {
      await db.run(
        "INSERT OR REPLACE INTO tenant_config (key, value) VALUES (?, ?)",
        [key, value ? 'true' : 'false']
      );
      continue;
    }

    await db.run(
      `INSERT OR REPLACE INTO system_config (config_key, config_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
      [key, String(value), new Date().toISOString(), req.user.id]
    );
  }

  res.json({
    success: true,
    message: 'Módulos atualizados com sucesso'
  });

  // Log audit
  await auditService.logAction({
      req,
      action: 'UPDATE',
      entity_type: 'system_config',
      description: 'Atualização de módulos do sistema',
      new_values: modules
  });
});

export const getReportCompany = asyncHandler(async (req, res) => {
  const db = req.db;

  const configs = await db.all(
    "SELECT * FROM system_config WHERE config_key LIKE 'report_company_%'"
  );

  const defaults = {
    razao: '',
    cnpj: '',
    endereco: '',
    telefone: '',
    email: ''
  };

  const company = { ...defaults };
  configs.forEach(c => {
    const key = c.config_key.replace('report_company_', '');
    company[key] = c.config_value || '';
  });

  res.json({
    success: true,
    data: company
  });
});

export const updateReportCompany = asyncHandler(async (req, res) => {
  const db = req.db;
  const fields = req.body;

  for (const [key, value] of Object.entries(fields)) {
    await db.run(
      `INSERT OR REPLACE INTO system_config (config_key, config_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
      [`report_company_${key}`, value || '', new Date().toISOString(), req.user.id]
    );
  }

  res.json({
    success: true,
    message: 'Dados da empresa atualizados com sucesso'
  });

  await auditService.logAction({
    req,
    action: 'UPDATE',
    entity_type: 'system_config',
    description: 'Atualizacao dos dados da empresa para relatórios',
    new_values: fields
  });
});

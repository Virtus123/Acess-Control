function getPathPrefix() {
    const path = window.location.pathname;
    const depth = (path.match(/\//g) || []).length - 1;
    return depth > 1 ? '../../' : depth === 1 ? '../' : '';
}

function getHeader() {
    return `
        <header class="main-header">
            <div class="header-left">
                <button class="menu-toggle" onclick="toggleSidebar()" aria-label="Toggle menu">
                    <i class="fas fa-bars"></i>
                </button>
                <div class="breadcrumb" id="breadcrumb">
                    <i class="fas fa-home"></i>
                    <span>Dashboard</span>
                </div>
            </div>
            <div class="header-right">
                <div class="user-menu">
                    <div class="user-info">
                        <div class="user-avatar">
                            <i class="fas fa-user"></i>
                        </div>
                        <div class="user-details">
                            <span class="user-name" id="user-name">Usuário</span>
                            <span class="user-role" id="user-role">Administrador</span>
                        </div>
                    </div>
                </div>
                <button class="header-action" title="Notificações" onclick="showNotificationsPopup()">
                    <i class="fas fa-bell"></i>
                    <span class="notification-badge" id="notification-count">0</span>
                </button>
                <button class="header-action" title="Ajuda">
                    <i class="fas fa-question-circle"></i>
                </button>
                <button class="header-action" title="Sair" onclick="if(typeof window.logout === 'function') { window.logout(); } else { handleLogout(); }">
                    <i class="fas fa-sign-out-alt"></i>
                </button>
            </div>
        </header>
    `;
}

function getSidebar() {
    const prefix = getPathPrefix();
    return `
        <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar()"></div>
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <div class="logo">
                    <img src="${prefix}favicon.png" alt="MAM Control" draggable="false">
                    <div class="logo-text">
                        <h2>MAM Control</h2>
                        <small>Sistema de Controle</small>
                    </div>
                </div>
                <button class="sidebar-toggle" onclick="toggleSidebar()" aria-label="Toggle sidebar">
                    <i class="fas fa-chevron-left"></i>
                </button>
            </div>

            <nav class="sidebar-nav">
                <div class="menu-section">
                    <a href="${prefix}dashboard" class="menu-item" data-section="dashboard">
                        <i class="fas fa-chart-line"></i>
                        <span>Dashboard</span>
                    </a>
                </div>

                <div class="menu-section">
                    <a href="${prefix}pages/autorizacao/acesso-pessoas" class="menu-item" data-section="acesso-pessoas">
                        <i class="fas fa-user"></i>
                        <span>Acesso Gerais</span>
                    </a>
                </div>
                <div class="menu-section">
                    <a href="${prefix}pages/notas/notas" class="menu-item" data-section="notas">
                        <i class="fa-solid fa-book"></i>
                        <span>Anotações</span>
                    </a>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('cadastros')">
                        <i class="fas fa-address-book"></i>
                        <span>Cadastros</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="cadastros-submenu">
                        <a href="${prefix}pages/cadastros/pessoas" class="submenu-item" data-section="pessoas">
                            <i class="fas fa-user"></i>
                            <span class="label-pessoas">Pessoas</span>
                        </a>
                        <a href="${prefix}pages/cadastros/grupos" class="submenu-item" data-section="grupos">
                            <i class="fas fa-layer-group"></i>
                            <span class="label-grupos">Grupos/Departamentos</span>
                        </a>
                        <a href="${prefix}pages/cadastros/empresas" class="submenu-item" data-section="empresas">
                            <i class="fas fa-building"></i>
                            <span>Empresas</span>
                        </a>
                        <a href="${prefix}pages/cadastros/feriados" class="submenu-item" data-section="feriados">
                            <i class="fas fa-calendar-day"></i>
                            <span>Feriados</span>
                        </a>
                        <a href="${prefix}pages/cadastros/veiculos" class="submenu-item" data-section="veiculos">
                            <i class="fas fa-car"></i>
                            <span>Veículos</span>
                        </a>
                        <a href="${prefix}pages/cadastros/estacionamentos" class="submenu-item" data-section="estacionamentos">
                            <i class="fas fa-parking"></i>
                            <span>Estacionamento</span>
                        </a>
                        <a href="${prefix}pages/cadastros/refeitorio" class="submenu-item" data-section="refeitorio">
                            <i class="fas fa-utensils"></i>
                            <span>Refeitório</span>
                        </a>
                        <a href="${prefix}pages/cadastros/encomendas" class="submenu-item" data-section="encomendas">
                            <i class="fas fa-box"></i>
                            <span>Encomendas</span>
                        </a>
                        <a href="${prefix}pages/cadastros/claviculario" class="submenu-item" data-section="claviculario">
                            <i class="fas fa-key"></i>
                            <span>Claviculário</span>
                        </a>
                    </div>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('visitantes')">
                        <i class="fas fa-user-check"></i>
                        <span>Visitantes</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="visitantes-submenu">
                        <a href="${prefix}pages/visitantes/lista" class="submenu-item" data-section="visitantes">
                            <i class="fas fa-list"></i>
                            <span>Lista de Visitantes</span>
                        </a>
                        <a href="${prefix}pages/visitantes/modulo-cadastro" class="submenu-item" data-section="visitantes-modulo">
                            <i class="fas fa-user-plus"></i>
                            <span>Módulo de Cadastro</span>
                        </a>
                    </div>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('regras')">
                        <i class="fas fa-lock"></i>
                        <span>Autorização</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="regras-submenu">
                        <a href="${prefix}pages/autorizacao/horarios" class="submenu-item" data-section="horarios">
                            <i class="fas fa-clock"></i>
                            <span>Horários</span>
                        </a>
                        <a href="${prefix}pages/autorizacao/nivelacesso-pessoas" class="submenu-item" data-section="nivelacesso-pessoas">
                            <i class="fas fa-user-shield"></i>
                            <span>Nível de Acesso Pessoas</span>
                        </a>
                        <a href="${prefix}pages/autorizacao/nivelacesso-veiculos" class="submenu-item" data-section="nivelacesso-veiculos">
                            <i class="fas fa-car-side"></i>
                            <span>Nível de Acesso Veículos</span>
                        </a>
                        <a href="${prefix}pages/autorizacao/refeicao" class="submenu-item" data-section="refeicao-autorizacao">
                            <i class="fas fa-utensils"></i>
                            <span>Refeição</span>
                        </a>
                        <a href="${prefix}pages/autorizacao/claviculario" class="submenu-item" data-section="claviculario-autorizacao">
                            <i class="fas fa-key"></i>
                            <span>Claviculário</span>
                        </a>
                    </div>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('equipamentos')">
                        <i class="fas fa-network-wired"></i>
                        <span>Equipamentos</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="equipamentos-submenu">
                        <a href="${prefix}pages/equipamentos/cadastro" class="submenu-item" data-section="equipamentos-cadastro">
                            <i class="fas fa-server"></i>
                            <span>Cadastro</span>
                        </a>
                        <a href="${prefix}pages/equipamentos/status" class="submenu-item" data-section="equipamentos-status">
                            <i class="fas fa-heartbeat"></i>
                            <span>Status</span>
                        </a>
                        <a href="${prefix}pages/equipamentos/notificacao" class="submenu-item" data-section="equipamentos-notificacao">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span>Notificações</span>
                        </a>
                    </div>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('relatorios')">
                        <i class="fas fa-file-invoice"></i>
                        <span>Relatórios</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="relatorios-submenu">
                        <a href="${prefix}pages/relatorios/cadastros" class="submenu-item" data-section="relatorios-cadastros">
                            <i class="fas fa-plus-circle"></i>
                            <span>Cadastros gerais</span>
                        </a>
                        <a href="${prefix}pages/relatorios/acessos" class="submenu-item" data-section="relatorios-acessos">
                            <i class="fas fa-walking"></i>
                            <span>Acessos de Pessoas</span>
                        </a>
                        <a href="${prefix}pages/relatorios/acessos-veiculos" class="submenu-item" data-section="relatorios-acessos-veiculos">
                            <i class="fas fa-car"></i>
                            <span>Acessos de Veículos</span>
                        </a>
                    </div>
                </div>

                <div class="menu-section">
                    <div class="menu-item" onclick="toggleSubmenu('sistema')">
                        <i class="fas fa-cog"></i>
                        <span>Sistema</span>
                        <span class="menu-arrow">
                            <i class="fas fa-chevron-down"></i>
                        </span>
                    </div>
                    <div class="submenu" id="sistema-submenu">
                        <a href="${prefix}pages/sistema/usuarios" class="submenu-item" data-section="configuracoes">
                            <i class="fas fa-users-cog"></i>
                            <span>Usuários & Permissões</span>
                        </a>
                        <a href="${prefix}pages/sistema/preferencias" class="submenu-item" data-section="preferencias">
                            <i class="fas fa-sliders-h"></i>
                            <span>Preferências</span>
                        </a>
                        <a href="${prefix}pages/sistema/autorizacao" class="submenu-item" data-section="autorizacao">
                            <i class="fas fa-clipboard-check"></i>
                            <span>Autorizações</span>
                        </a>
                        <a href="${prefix}pages/sistema/auditoria" class="submenu-item" data-section="auditoria">
                            <i class="fas fa-history"></i>
                            <span>Auditoria</span>
                        </a>
                        <a href="${prefix}pages/sistema/tarefas" class="submenu-item" data-section="tarefas">
                            <i class="fas fa-tasks"></i>
                            <span>Fila de Tarefas</span>
                        </a>
                        <a href="${prefix}pages/sistema/emails" class="submenu-item" data-section="emails">
                            <i class="fas fa-envelope-open-text"></i>
                            <span>Fila de E-mails</span>
                        </a>
                    </div>
                </div>
            </nav>

            <div class="sidebar-footer">
                <div class="footer-info">
                    <span class="tenant-name" id="sidebar-tenant-name">Empresa</span>
                    <span class="system-version">v2.1.0</span>
                </div>
            </div>
        </aside>
    `;
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
    document.getElementById('sidebar-overlay').classList.toggle('active');
}

function toggleSubmenu(submenuId) {
    const submenu = document.getElementById(`${submenuId}-submenu`);
    const menuItem = submenu.previousElementSibling;
    const arrow = menuItem.querySelector('.menu-arrow i');

    submenu.classList.toggle('active');
    arrow.classList.toggle('fa-chevron-down');
    arrow.classList.toggle('fa-chevron-up');
}

function handleLogout() {
    // Limpar todos os tokens possíveis
    localStorage.removeItem('auth_token');
    localStorage.removeItem('tenant_id');
    localStorage.removeItem('mamcontrol_accessToken');
    localStorage.removeItem('mamcontrol_refreshToken');
    localStorage.removeItem('mamcontrol_user');
    localStorage.removeItem('mamcontrol_loginTime');
    localStorage.removeItem('mamcontrol_tenant');
    localStorage.removeItem('mamcontrol_modules');

    const prefix = getPathPrefix();
    window.location.href = prefix + 'index';
}

// Mapeamento de módulos para elementos do menu
const moduleToMenuMap = {
    // Cadastros e Módulos Globais
    'module_pessoas': '[data-section="pessoas"]',
    'module_visitantes': '#visitantes-submenu',
    'module_veiculos': '[data-section="veiculos"]',
    'module_empresas': '[data-section="empresas"]',
    'module_horarios': '[data-section="horarios"]',
    'module_feriados': '[data-section="feriados"]',
    'module_estacionamento': '[data-section="estacionamentos"]',
    'module_equipamentos': '#equipamentos-submenu',

    // Submenus e Recursos adicionais
    'module_cadastro_refeitorio': '[data-section="refeitorio"]',
    'module_cadastro_encomendas': '[data-section="encomendas"]',
    'module_cadastro_claviculario': '[data-section="claviculario"]',

    // Autorização
    'module_autorizacao_refeicao': '[data-section="refeicao-autorizacao"]',
    'module_autorizacao_claviculario': '[data-section="claviculario-autorizacao"]',
    'module_autorizacao_nivel_acesso_veiculos': '[data-section="nivelacesso-veiculos"]',
    'module_autorizacao_acesso_veiculos': '[data-section="acesso-veiculos"]'
};

// Mapeamento de seções do menu para recursos dos perfis de autorização
// O module deve corresponder ao que está salvo no banco
const menuSectionToResource = {
    // Sistema
    '[data-section="configuracoes"]': { module: 'sistema', resource: 'usuarios' },
    '[data-section="preferencias"]': { module: 'sistema', resource: 'preferencias' },
    '[data-section="autorizacao"]': { module: 'sistema', resource: 'autorizacao' },
    '[data-section="auditoria"]': { module: 'sistema', resource: 'auditoria' },
    '[data-section="tarefas"]': { module: 'sistema', resource: 'autorizacao' },
    '[data-section="emails"]': { module: 'sistema', resource: 'notificacao' },
    '[data-section="notas"]': { module: 'encomendas', resource: 'encomendas' }, // Map notes to encomendas for now or add a new one
    // Cadastros
    '[data-section="pessoas"]': { module: 'pessoas', resource: 'pessoas' },
    '[data-section="grupos"]': { module: 'grupos', resource: 'grupos' },
    '[data-section="empresas"]': { module: 'empresas', resource: 'empresas' },
    '[data-section="feriados"]': { module: 'feriados', resource: 'feriados' },
    '[data-section="veiculos"]': { module: 'veiculos', resource: 'veiculos' },
    '[data-section="estacionamentos"]': { module: 'estacionamentos', resource: 'estacionamentos' },
    '[data-section="refeitorio"]': { module: 'refeitorio', resource: 'refeitorio' },
    '[data-section="encomendas"]': { module: 'encomendas', resource: 'encomendas' },
    '[data-section="notas-turno"]': { module: 'encomendas', resource: 'encomendas' },
    '[data-section="claviculario"]': { module: 'claviculario', resource: 'claviculario' },
    // Visitantes
    '[data-section="visitantes"]': { module: 'visitantes', resource: 'lista' },
    '[data-section="visitantes-modulo"]': { module: 'visitantes', resource: 'cadastro' },
    // Autorização
    '[data-section="horarios"]': { module: 'horarios', resource: 'horarios' },
    '[data-section="nivelacesso-pessoas"]': { module: 'pessoas', resource: 'nivel' },
    '[data-section="nivelacesso-veiculos"]': { module: 'veiculos', resource: 'nivel' },
    '[data-section="refeicao-autorizacao"]': { module: 'refeicao', resource: 'refeicao' },
    '[data-section="claviculario-autorizacao"]': { module: 'claviculario', resource: 'claviculario' },
    '[data-section="acesso-pessoas"]': { module: 'acessos', resource: 'pessoas' },
    // Equipamentos
    '[data-section="equipamentos-cadastro"]': { module: 'equipamentos', resource: 'cadastro' },
    '[data-section="equipamentos-status"]': { module: 'equipamentos', resource: 'status' },
    '[data-section="equipamentos-notificacao"]': { module: 'notificacoes', resource: 'notificacoes' },
    // Relatórios
    '[data-section="relatorios-cadastros"]': { module: 'relatorios', resource: 'relatorios' },
    '[data-section="relatorios-acessos"]': { module: 'relatorios', resource: 'relatorios' },
    '[data-section="relatorios-acessos-veiculos"]': { module: 'relatorios', resource: 'relatorios' },
    // Dashboard
    '[data-section="dashboard"]': { module: 'dashboard', resource: 'dashboard' }
};

// Carregar módulos do servidor
async function loadModules() {
    try {
        const tenantId = localStorage.getItem('mamcontrol_tenant') || 'default';
        const token = localStorage.getItem('mamcontrol_accessToken');

        const headers = {
            'Content-Type': 'application/json',
            'X-Tenant-ID': tenantId
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch('/api/config/modules', {
                method: 'GET',
                headers: headers
            });

            const result = await response.json();

            if (result.success && result.data) {
                const modules = result.data;
                localStorage.setItem('mamcontrol_modules', JSON.stringify(modules));
                return modules;
            }
        } catch (e) {
            console.warn('Erro ao buscar módulos do servidor, usando cache local:', e);
        }

        let modules = localStorage.getItem('mamcontrol_modules');
        if (modules) {
            return JSON.parse(modules);
        }

        return {};
    } catch (error) {
        console.error('Erro ao carregar módulos:', error);
        return {};
    }
}

// Aplicar permissões do perfil de autorização ao menu
async function applyAuthorizationPermissions() {
    try {
        const token = localStorage.getItem('mamcontrol_accessToken');
        const userData = localStorage.getItem('mamcontrol_user');

        if (!token || !userData) return;

        const parsed = JSON.parse(userData);
        let permissions = parsed.profilePermissions || [];
        const profileId = parsed.profile_id;

        // Se tem profile_id mas não tem permissões no localStorage, buscar da API
        if (profileId && permissions.length === 0) {
            console.log('Buscando permissões da API para o perfil:', profileId);
            try {
                const response = await fetch(`/api/authorization-profiles/profiles/${profileId}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'X-Tenant-ID': localStorage.getItem('mamcontrol_tenant') }
                });
                const result = await response.json();
                if (result.success && result.data?.permissions) {
                    permissions = result.data.permissions;
                    parsed.profilePermissions = permissions;
                    localStorage.setItem('mamcontrol_user', JSON.stringify(parsed));
                }
            } catch (e) {
                console.error('Erro ao buscar permissões:', e);
            }
        }

        // Determinar se é Admin (Bypass)
        let isAdmin = false;
        const role = (parsed.role || '').toLowerCase();
        const storedRole = (localStorage.getItem('user_role') || '').toLowerCase();

        // Se é role admin, liberamos acesso total SE não houver profile ou se o profile não tiver permissões explícitas
        if (role === 'admin' || role === 'administrador' || role === 'administradora' ||
            storedRole === 'admin' || storedRole === 'administrador' || storedRole === 'administradora') {
            if (!profileId || permissions.length === 0) {
                console.log('Admin detectado (bypass), liberando acesso total.');
                isAdmin = true;
            }
        }

        // Carregar módulos para verificar visibilidade global
        const modules = JSON.parse(localStorage.getItem('mamcontrol_modules') || '{}');
        const userRole = (parsed.role || '').toLowerCase();

        console.log('--- DEBUG MENU VISIBILITY ---');
        console.log('User Role:', userRole);
        console.log('Is Admin (Bypass):', isAdmin);
        console.log('Local Modules:', modules);

        // Para cada item do menu, verificar se tem permissão
        for (const [selector, resourceInfo] of Object.entries(menuSectionToResource)) {
            const elements = document.querySelectorAll(selector);

            if (elements.length > 0) {
                // Verificar se este seletor está mapeado para algum módulo que está desativado
                let isModuleDisabled = false;

                for (const [mKey, mSelector] of Object.entries(moduleToMenuMap)) {
                    let matched = false;
                    if (mSelector === selector) {
                        matched = true;
                    } else if (mSelector.startsWith('#') || mSelector.startsWith('.')) {
                        const parentEl = document.querySelector(mSelector);
                        if (parentEl) {
                            elements.forEach(el => {
                                if (parentEl.contains(el)) matched = true;
                            });
                        }
                    }

                    if (matched) {
                        const mValue = modules[mKey];
                        // Consideramos desativado se o valor for explicitamente 'false' ou false
                        if (mValue === 'false' || mValue === false) {
                            isModuleDisabled = true;
                            console.log(`Módulo ${mKey} desativado para o seletor ${selector}`);
                            break;
                        }
                    }
                }

                // Se o módulo está desativado globalmente, esconder SEMPRE (mesmo para admin se ele desativou)
                if (isModuleDisabled) {
                    elements.forEach(el => el.style.display = 'none');
                    continue;
                }

                // Dashboard, Acesso Pessoas e Admin Master SEMPRE veem tudo (se o módulo estiver ativo)
                if (selector === '[data-section="dashboard"]' || selector === '[data-section="acesso-pessoas"]' || isAdmin) {
                    elements.forEach(el => el.style.display = '');
                    continue;
                }

                // Buscar permissão para este recurso
                let perm = permissions.find(p =>
                    p.module === resourceInfo.module &&
                    p.resource === resourceInfo.resource
                );

                // Suporte para nomes de recursos legados (fallback) para garantir compatibilidade com perfis antigos
                if (!perm) {
                    if (resourceInfo.resource === 'lista') perm = permissions.find(p => p.resource === 'visitantes');
                    if (resourceInfo.resource === 'cadastro' && resourceInfo.module === 'visitantes') perm = permissions.find(p => p.resource === 'visitantes');
                    if (resourceInfo.resource === 'cadastro' && resourceInfo.module === 'equipamentos') perm = permissions.find(p => p.resource === 'equipamentos');
                    if (resourceInfo.module === 'sistema' && resourceInfo.resource === 'usuarios') perm = permissions.find(p => p.resource === 'configuracoes' || p.resource === 'usuarios');
                    if (resourceInfo.module === 'acessos' && resourceInfo.resource === 'pessoas') perm = permissions.find(p => p.resource === 'accessLog' || p.resource === 'acessos');
                    if (resourceInfo.module === 'pessoas' && resourceInfo.resource === 'pessoas') perm = permissions.find(p => p.resource === 'lista' || p.module === 'pessoas');
                }

                // Se não encontrou permissão ou não tem can_view, esconder
                if (!perm || !perm.can_view) {
                    elements.forEach(el => el.style.display = 'none');
                } else {
                    elements.forEach(el => el.style.display = '');
                }
            }
        }
    } catch (error) {
        console.error('applyAuthorizationPermissions: Erro:', error);
    }
}

// Verificar e ocultar submenus vazios
function checkEmptySubmenus() {
    const submenus = [
        { id: 'visitantes-submenu', section: '.menu-section' },
        { id: 'equipamentos-submenu', section: '.menu-section' },
        { id: 'cadastros-submenu', section: '.menu-section' },
        { id: 'regras-submenu', section: '.menu-section' },
        { id: 'sistema-submenu', section: '.menu-section' },
        { id: 'relatorios-submenu', section: '.menu-section' }
    ];

    submenus.forEach(({ id, section }) => {
        const submenu = document.getElementById(id);
        if (submenu) {
            const parentSection = submenu.closest(section);
            // Conta itens que NÃO estão com display: none (verifica apenas o estilo próprio)
            const visibleItems = Array.from(submenu.querySelectorAll('a')).filter(el => {
                return el.style.display !== 'none';
            });

            if (parentSection) {
                if (visibleItems.length === 0) {
                    parentSection.style.display = 'none';
                } else {
                    parentSection.style.display = '';
                }
            }
        }
    });
}

// Aplicar módulos ao menu
function applyModulesToMenu(modules) {
    // Módulos que por padrão são desativados (false)
    const defaultDisabled = [
        'module_cadastro_refeitorio',
        'module_cadastro_claviculario',
        'module_cadastro_estacionamento',
        'module_cadastro_veiculos',
        'module_autorizacao_refeicao',
        'module_autorizacao_claviculario',
        'module_autorizacao_nivel_acesso_veiculos',
        'module_autorizacao_acesso_veiculos',
        'module_estacionamento'
    ];

    for (const [moduleKey, selector] of Object.entries(moduleToMenuMap)) {
        const moduleValue = modules[moduleKey];
        const isDisabled = moduleValue === 'false' || moduleValue === false;

        const shouldHide = defaultDisabled.includes(moduleKey)
            ? (moduleValue !== 'true' && moduleValue !== true)
            : (isDisabled);

        const elements = document.querySelectorAll(selector);

        if (elements.length > 0) {
            if (shouldHide) {
                elements.forEach(el => el.style.display = 'none');
            } else {
                elements.forEach(el => el.style.display = '');
            }
        }
    }
}

// Chamar todas as funções de visibilidade
async function updateMenuVisibility(modules) {
    if (modules) applyModulesToMenu(modules);
    await applyAuthorizationPermissions();
    checkEmptySubmenus();
}

// ============== FUNÇÕES DE NOTIFICAÇÕES GLOBAIS ==============
let notificationsPopup = null;

async function showNotificationsPopup() {
    try {
        const tenantId = localStorage.getItem('mamcontrol_tenant') || 'default';
        const response = await fetch(`/api/notifications?tenant_id=${encodeURIComponent(tenantId)}`);
        const notifications = await response.json();

        if (notificationsPopup) {
            notificationsPopup.remove();
        }

        notificationsPopup = document.createElement('div');
        notificationsPopup.className = 'notifications-popup';
        notificationsPopup.id = 'notifications-popup';

        let notificationsHtml = `
            <div class="notifications-header">
                <h3>Notificações</h3>
                <button onclick="closeNotificationsPopup()" class="notifications-close">&times;</button>
            </div>
            <div class="notifications-list">
        `;

        if (notifications.length === 0) {
            notificationsHtml += `
                <div class="notification-empty">
                    <i class="fas fa-bell-slash"></i>
                    <p>Nenhuma notificação</p>
                </div>
            `;
        } else {
            notifications.forEach(notif => {
                const date = new Date(notif.created_at);
                const formattedDate = date.toLocaleString('pt-BR');
                const isRead = notif.is_read === 1;
                const readClass = isRead ? 'notification-read' : 'notification-unread';
                const unreadDot = isRead ? '' : '<span class="unread-dot"></span>';
                notificationsHtml += `
                    <div class="notification-item ${readClass}" onclick="showNotificationDetail(${notif.id}, '${notif.title.replace(/'/g, "\\'")}', '${notif.message.replace(/'/g, "\\'").replace(/\n/g, '\\n')}', '${formattedDate}', ${notif.is_prioritary === 1})">
                        <div class="notification-icon">
                            <i class="fas fa-bell"></i>
                            ${unreadDot}
                        </div>
                        <div class="notification-content">
                            <div class="notification-title">${notif.title}</div>
                            <div class="notification-message">${notif.message.substring(0, 50)}${notif.message.length > 50 ? '...' : ''}</div>
                            <div class="notification-date">${formattedDate}</div>
                        </div>
                    </div>
                `;
            });
        }

        notificationsHtml += '</div>';
        notificationsPopup.innerHTML = notificationsHtml;

        document.body.appendChild(notificationsPopup);

        // Adicionar estilos se ainda não existirem
        addNotificationStyles();

        // Fechar ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', handleOutsideClick);
        }, 100);
    } catch (error) {
        console.error('Erro ao carregar notificações:', error);
    }
}

function closeNotificationsPopup() {
    if (notificationsPopup) {
        notificationsPopup.remove();
        notificationsPopup = null;
    }
    document.removeEventListener('click', handleOutsideClick);
}

function handleOutsideClick(event) {
    const popup = document.getElementById('notifications-popup');
    const bellButton = document.querySelector('.header-action[onclick*="showNotificationsPopup"]');

    if (popup && !popup.contains(event.target) && (!bellButton || !bellButton.contains(event.target))) {
        closeNotificationsPopup();
    }
}

function showNotificationDetail(id, title, message, date, isPrioritary = false) {
    closeNotificationsPopup();

    // Criar modal de detalhes
    const modal = document.createElement('div');
    modal.className = 'modal active notification-detail-modal';
    const priorityBadge = isPrioritary ? '<span class="priority-badge"><i class="fas fa-exclamation-triangle"></i> Prioritária</span>' : '';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2><i class="fas fa-bell"></i> ${title} ${priorityBadge}</h2>
                <button class="modal-close" onclick="this.closest('.modal').remove()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="detail-row">
                    <strong><i class="fas fa-calendar"></i> Data:</strong>
                    <span>${date}</span>
                </div>
                <div class="detail-message">
                    <strong><i class="fas fa-align-left"></i> Mensagem:</strong>
                    <p>${message.replace(/\\n/g, '\n')}</p>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary" onclick="this.closest('.modal').remove(); markNotificationAsRead(${id});">Fechar</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Adicionar estilos do modal
    addNotificationModalStyles();

    // Fechar ao clicar fora
    modal.addEventListener('click', function (e) {
        if (e.target === modal) {
            markNotificationAsRead(id);
            modal.remove();
        }
    });
}

// Marcar notificação como lida
async function markNotificationAsRead(id) {
    try {
        const tenantId = localStorage.getItem('mamcontrol_tenant') || 'default';
        console.log('Marcando notificação como lida:', id, 'tenant:', tenantId);
        const response = await fetch(`/api/notifications/${id}/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tenant_id: tenantId })
        });
        const result = await response.json();
        console.log('Resultado:', result);
        updateNotificationCount();
    } catch (error) {
        console.error('Erro ao marcar notificação como lida:', error);
    }
}

// Verificar e abrir notificações prioritárias ao carregar a página
async function checkPrioritaryNotifications() {
    try {
        const tenantId = localStorage.getItem('mamcontrol_tenant') || 'default';
        console.log('Verificando notificações prioritárias para tenant:', tenantId);
        const response = await fetch(`/api/notifications/unread-prioritary?tenant_id=${encodeURIComponent(tenantId)}`);
        const notifications = await response.json();
        console.log('Notificações retornadas:', notifications);

        if (notifications.length > 0) {
            // Abrir a primeira notificação prioritária não lida
            const notif = notifications[0];
            const date = new Date(notif.created_at).toLocaleString('pt-BR');
            showNotificationDetail(notif.id, notif.title, notif.message, date, true);
        }
    } catch (error) {
        console.error('Erro ao verificar notificações prioritárias:', error);
    }
}

function addNotificationStyles() {
    if (document.getElementById('notification-styles')) return;

    const style = document.createElement('style');
    style.id = 'notification-styles';
    style.textContent = `
        .notifications-popup {
            position: fixed;
            top: 70px;
            right: 20px;
            width: 380px;
            max-height: 500px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.15);
            z-index: 9999;
            overflow: hidden;
            animation: slideDown 0.3s ease;
        }
        
        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .notifications-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .notifications-header h3 {
            margin: 0;
            font-size: 1.1rem;
        }
        
        .notifications-close {
            background: none;
            border: none;
            color: white;
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        }
        
        .notifications-list {
            max-height: 400px;
            overflow-y: auto;
        }
        
        .notification-empty {
            padding: 40px 20px;
            text-align: center;
            color: #6b7280;
        }
        
        .notification-empty i {
            font-size: 2.5rem;
            margin-bottom: 10px;
            color: #d1d5db;
        }
        
        .notification-item {
            display: flex;
            gap: 12px;
            padding: 15px 20px;
            border-bottom: 1px solid #e5e7eb;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .notification-item:hover {
            background: #f3f4f6;
        }
        
        .notification-item:last-child {
            border-bottom: none;
        }
        
        .notification-icon {
            width: 40px;
            height: 40px;
            background: #dbeafe;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #667eea;
            flex-shrink: 0;
        }
        
        .notification-content {
            flex: 1;
            min-width: 0;
        }
        
        .notification-title {
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 4px;
        }
        
        .notification-message {
            font-size: 0.85rem;
            color: #6b7280;
            margin-bottom: 4px;
        }
        
        .notification-date {
            font-size: 0.75rem;
            color: #9ca3af;
        }
        
        /* Estados de leitura */
        .notification-unread {
            background: #eff6ff;
            border-left: 3px solid #3b82f6;
        }
        
        .notification-read {
            opacity: 0.7;
            background: #f9fafb;
        }
        
        .notification-read .notification-icon {
            background: #e5e7eb;
            color: #9ca3af;
        }
        
        .unread-dot {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 8px;
            height: 8px;
            background: #ef4444;
            border-radius: 50%;
            animation: pulse-dot 2s infinite;
        }
        
        @keyframes pulse-dot {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.2); opacity: 0.7; }
        }
    `;
    document.head.appendChild(style);
}

function addNotificationModalStyles() {
    if (document.getElementById('notification-modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'notification-modal-styles';
    style.textContent = `
        /* Overlay do Modal - CORRIGIDO - Centralização Forçada */
        .notification-detail-modal {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(4px);
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            z-index: 999999 !important;
            opacity: 0;
            visibility: hidden;
            transition: all 0.3s ease;
            margin: 0 !important;
            padding: 0 !important;
            box-sizing: border-box !important;
        }
        
        .notification-detail-modal.active {
            opacity: 1 !important;
            visibility: visible !important;
        }
        
        .notification-detail-modal .modal-container {
            background: white;
            border-radius: 16px;
            width: 90%;
            max-width: 550px;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.25);
            transform: scale(0.95);
            transition: transform 0.3s ease;
            position: relative;
            margin: 20px !important;
        }
        
        .notification-detail-modal.active .modal-container {
            transform: scale(1);
        }
        
        /* Header do Modal */
        .notification-detail-modal .modal-header {
            padding: 20px 24px;
            border-bottom: 2px solid #e2e8f0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #f8fafc;
            border-radius: 16px 16px 0 0;
            position: sticky;
            top: 0;
            z-index: 10;
        }
        
        .notification-detail-modal .modal-header h2 {
            margin: 0;
            color: #1e293b;
            font-size: 1.25rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .notification-detail-modal .modal-header h2 i {
            color: #4a90d9;
            font-size: 1.4rem;
        }
        
        .notification-detail-modal .modal-close {
            background: none;
            border: none;
            font-size: 1.2rem;
            cursor: pointer;
            color: #94a3b8;
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            transition: all 0.2s;
        }
        
        .notification-detail-modal .modal-close:hover {
            background: #fee2e2;
            color: #ef4444;
        }
        
        /* Body do Modal */
        .notification-detail-modal .modal-body {
            padding: 24px;
        }
        
        .notification-detail-modal .detail-row {
            display: flex;
            align-items: flex-start;
            gap: 16px;
            margin-bottom: 16px;
            padding: 12px;
            background: #f8fafc;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
        }
        
        .notification-detail-modal .detail-row i {
            width: 24px;
            color: #4a90d9;
            font-size: 1.1rem;
            margin-top: 2px;
        }
        
        .notification-detail-modal .detail-content {
            flex: 1;
        }
        
        .notification-detail-modal .detail-content strong {
            display: block;
            font-size: 0.8rem;
            font-weight: 600;
            color: #475569;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            margin-bottom: 4px;
        }
        
        .notification-detail-modal .detail-content span {
            font-size: 0.95rem;
            color: #1e293b;
        }
        
        /* Mensagem em destaque */
        .notification-detail-modal .detail-message {
            background: #f8fafc;
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #e2e8f0;
            margin-top: 20px;
        }
        
        .notification-detail-modal .detail-message strong {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 12px;
            color: #1e293b;
            font-size: 0.95rem;
            font-weight: 600;
        }
        
        .notification-detail-modal .detail-message strong i {
            color: #4a90d9;
        }
        
        .notification-detail-modal .detail-message p {
            margin: 0;
            color: #334155;
            line-height: 1.6;
            white-space: pre-wrap;
            background: white;
            padding: 16px;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
        }
        
        /* Badge de tipo */
        .notification-detail-modal .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        
        .notification-detail-modal .badge-info {
            background: #dbeafe;
            color: #1e40af;
        }
        
        .notification-detail-modal .badge-success {
            background: #d1fae5;
            color: #065f46;
        }
        
        .notification-detail-modal .badge-warning {
            background: #fef3c7;
            color: #92400e;
        }
        
        .notification-detail-modal .badge-danger {
            background: #fee2e2;
            color: #991b1b;
        }
        
        /* Footer do Modal */
        .notification-detail-modal .modal-footer {
            padding: 20px 24px;
            border-top: 2px solid #e2e8f0;
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            background: #f8fafc;
            border-radius: 0 0 16px 16px;
            position: sticky;
            bottom: 0;
            z-index: 10;
        }
        
        .notification-detail-modal .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            font-size: 0.95rem;
            font-weight: 500;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
        }
        
        .notification-detail-modal .btn i {
            font-size: 1rem;
        }
        
        .notification-detail-modal .btn-primary {
            background: #4a90d9;
            color: white;
        }
        
        .notification-detail-modal .btn-primary:hover {
            background: #3a78c2;
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(74, 144, 217, 0.2);
        }
        
        .notification-detail-modal .btn-secondary {
            background: #e2e8f0;
            color: #475569;
        }
        
        .notification-detail-modal .btn-secondary:hover {
            background: #cbd5e0;
            transform: translateY(-1px);
        }
        
        /* Responsividade */
        @media (max-width: 640px) {
            .notification-detail-modal .modal-container {
                width: 95%;
                margin: 10px !important;
            }
            
            .notification-detail-modal .modal-header {
                padding: 16px 20px;
            }
            
            .notification-detail-modal .modal-body {
                padding: 20px;
            }
            
            .notification-detail-modal .modal-footer {
                padding: 16px 20px;
            }
            
            .notification-detail-modal .detail-row {
                flex-direction: column;
                gap: 8px;
            }
            
            .notification-detail-modal .detail-row i {
                margin-bottom: 4px;
            }
        }
        
        /* Badge de Prioridade */
        .priority-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #dc2626, #b91c1c);
            color: white;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            animation: pulse-badge 2s infinite;
        }
        
        .priority-badge i {
            font-size: 0.85rem;
        }
        
        @keyframes pulse-badge {
            0%, 100% {
                box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4);
            }
            50% {
                box-shadow: 0 0 0 8px rgba(220, 38, 38, 0);
            }
        }
    `;
    document.head.appendChild(style);
}

// Atualizar badge de notificações
async function updateNotificationCount() {
    try {
        const tenantId = localStorage.getItem('mamcontrol_tenant') || 'default';
        const response = await fetch(`/api/notifications/count?tenant_id=${encodeURIComponent(tenantId)}`);
        const data = await response.json();
        const badge = document.getElementById('notification-count');
        if (badge) {
            badge.textContent = data.count;
            badge.style.display = data.count > 0 ? 'flex' : 'none';
        }
    } catch (error) {
        console.error('Erro ao atualizar contagem de notificações:', error);
    }
}

document.addEventListener('DOMContentLoaded', async function () {
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.insertAdjacentHTML('afterbegin', getHeader());
    }

    const appLayout = document.querySelector('.app-layout');
    if (appLayout) {
        appLayout.insertAdjacentHTML('afterbegin', getSidebar());

        // Carregar e aplicar visibilidade do menu (módulos e permissões)
        const modules = await loadModules();
        await updateMenuVisibility(modules);
    }

    const currentPath = window.location.pathname;
    const menuItems = document.querySelectorAll('.submenu-item, .menu-item[data-section]');

    menuItems.forEach(item => {
        const href = item.getAttribute('href');
        if (href) {
            const normalizedHref = href.startsWith('../') ? href : '../' + href;
            const normalizedPath = currentPath.replace(/\\/g, '/');

            if (normalizedPath.endsWith(href) || normalizedPath.includes(href.replace('../', ''))) {
                item.classList.add('active');
                const submenu = item.closest('.submenu');
                if (submenu) {
                    submenu.classList.add('active');
                    const menuItem = submenu.previousElementSibling;
                    if (menuItem) {
                        menuItem.classList.add('active');
                        const arrow = menuItem.querySelector('.menu-arrow i');
                        if (arrow) {
                            arrow.classList.remove('fa-chevron-down');
                            arrow.classList.add('fa-chevron-up');
                        }
                    }
                }
            }
        }
    });

    // Inicializar contagem de notificações
    updateNotificationCount();
    // Verificar notificações prioritárias ao carregar
    checkPrioritaryNotifications();
    // Atualizar a cada 30 segundos
    setInterval(updateNotificationCount, 30000);
});

window.showWarningToast = function (msg, duration = 10000) {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.top = '20px';
    el.style.right = '20px';
    el.style.background = '#e74c3c';
    el.style.color = '#fff';
    el.style.padding = '15px 25px';
    el.style.borderRadius = '4px';
    el.style.zIndex = '999999';
    el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    el.style.fontFamily = 'Inter, sans-serif';
    el.style.fontWeight = '500';
    el.style.fontSize = '14px';
    el.style.transition = 'opacity 0.4s ease';
    el.innerText = msg;
    document.body.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 400);
    }, duration);
};

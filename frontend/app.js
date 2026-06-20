/* ============================================
   MAM Control - Sistema de Controle de Acesso
   Versão 1.0.0
   ============================================ */

// ============================================
// CONFIGURAÇÃO E INICIALIZAÇÃO
// ============================================

// Configuração padrão do sistema
const CONFIG = {
    APP_NAME: 'MAM Control',
    VERSION: '1.0.0',
    STORAGE_PREFIX: 'mamcontrol_',
    DEFAULT_LABELS: {
        pessoas: 'Pessoas',
        grupos: 'Grupos/Departamentos'
    },
    MATRICULA_PREFIX: '26',
    MATRICULA_LENGTH: 6,
    API_URL: '/api', // Caminho relativo - Nginx faz reverse proxy automaticamente
    TENANT_ID: 'default' // ID do tenant, pode ser alterado
};

// ============================================
// HANDSHAKE DE IMPERSONATION (Consumir contexto da nova aba)
// ============================================
(function() {
    const impToken = localStorage.getItem('mamcontrol_impersonate_token');
    const impTenant = localStorage.getItem('mamcontrol_impersonate_tenant');
    if (impToken && impTenant) {
        // Armazenar APENAS no sessionStorage para isolar esta aba das demais.
        // O localStorage é compartilhado entre abas e se alterado aqui, 
        // "sequestraria" a sessão da aba Master/Revenda original.
        sessionStorage.setItem('mamcontrol_accessToken', impToken);
        sessionStorage.setItem('mamcontrol_tenant', impTenant);
        
        // Limpar os sinais de handshake do localStorage para que não sejam reprocessados
        localStorage.removeItem('mamcontrol_impersonate_token');
        localStorage.removeItem('mamcontrol_impersonate_tenant');
        console.log(`[Impersonation] Sincronização isolada no sessionStorage para o tenant: ${impTenant}`);
    }
})();

// ============================================
// FUNÇÕES AUXILIARES DE FOTOS (Criptografia)
// ============================================

/**
 * Converte URL de foto para endpoint de API descriptografado
 * Fotos são servidas via API para proteção (requer autenticação)
 */
function getPhotoUrl(photoUrl) {
    if (!photoUrl) return null;
    
    // Se já é uma URL completa ou URL de API, retornar como está
    if (photoUrl.startsWith('http') || photoUrl.startsWith('/api/')) {
        return photoUrl;
    }
    
    // Obter token de acesso para autenticação
    const accessToken = localStorage.getItem('mamcontrol_accessToken') || '';
    
    // Tentar extrair tipo (person ou visitor) e nome do arquivo
    // Normaliza path sem barra inicial: "uploads/..." → "/uploads/..."
    const normalizedUrl = photoUrl.startsWith('/') ? photoUrl : '/' + photoUrl;
    const match = normalizedUrl.match(/\/uploads\/photos\/(\w+)\/(.+)$/);
    if (match) {
        const type = match[1];
        const filename = match[2];
        // Usar endpoint de API com token como parâmetro
        return `/api/photos/${type}/${filename}?token=${encodeURIComponent(accessToken)}`;
    }
    
    // Se não conseguir parsear, retornar URL original
    return photoUrl;
}

/**
 * URL da foto para exibição (listagem/cadastro) — prioriza arquivo (photo_url), ignora base64 legado do banco.
 */
function resolvePersonPhotoSrc(pessoa) {
    if (!pessoa) return null;

    const fileRef = pessoa.photo_url || pessoa.photoUrl || pessoa.photoPath || null;
    if (fileRef && !String(fileRef).startsWith('data:')) {
        const apiUrl = getPhotoUrl(fileRef);
        if (!apiUrl) return null;
        const version = pessoa.updated_at || pessoa.updatedAt || pessoa.dataAtualizacao || Date.now();
        const sep = apiUrl.includes('?') ? '&' : '?';
        return `${apiUrl}${sep}v=${encodeURIComponent(version)}`;
    }

    const inline = pessoa.foto || pessoa.photo;
    if (inline && String(inline).startsWith('data:image')) {
        return inline;
    }

    return null;
}

// Estados do sistema
let STATE = {
    currentSection: 'dashboard',
    currentFormTab: 'dados-basicos',
    editMode: false,
    currentEditId: null,
    cameraActive: false,
    cameraStream: null,
    accessToken: localStorage.getItem('mamcontrol_accessToken') || null,
    refreshToken: localStorage.getItem('mamcontrol_refreshToken') || null,
    user: JSON.parse(localStorage.getItem('mamcontrol_user') || 'null'),
    personPhotoChanged: false
};

// ============================================
// INTERCEPTOR GLOBAL DE FETCH (Multi-tenant)
// ============================================

/**
 * Sobrescreve o fetch global para garantir que os headers de tenant e auth 
 * sejam enviados em todas as requisições de API.
 */
const originalFetch = window.fetch;
window.fetch = async (...args) => {
    let [resource, config] = args;
    
    // Só interceptar chamadas para a nossa API
    if (typeof resource === 'string' && (resource.startsWith('/api') || resource.startsWith(CONFIG.API_URL))) {
        config = config || {};
        config.headers = config.headers || {};

        // 1. Resolver Tenant ID (sessionStorage primeiro para suportar impersonation em novas abas)
        const tenantId = sessionStorage.getItem('mamcontrol_tenant') || 
                         localStorage.getItem('mamcontrol_tenant') || 
                         localStorage.getItem('tenant_id') || 
                         CONFIG.TENANT_ID;
        
        // 2. Resolver Token
        const token = sessionStorage.getItem('mamcontrol_accessToken') ||
                      localStorage.getItem('mamcontrol_accessToken');

        // Injetar headers (SOBERANO: sessionStorage tem precedência total se existir)
        const forcedTenant = sessionStorage.getItem('mamcontrol_tenant');
        const forcedToken = sessionStorage.getItem('mamcontrol_accessToken');

        if (forcedTenant) {
            config.headers['X-Tenant-ID'] = forcedTenant;
        } else if (!config.headers['X-Tenant-ID']) {
            config.headers['X-Tenant-ID'] = tenantId;
        }
        
        if (forcedToken) {
            config.headers['Authorization'] = `Bearer ${forcedToken}`;
        } else if (!config.headers['Authorization'] && token) {
            config.headers['Authorization'] = `Bearer ${token}`;
        }
    }
    
    return originalFetch(resource, config);
};

// ============================================
// SISTEMA DE APARÊNCIA (Fonte Global)
// ============================================

/**
 * Aplica o tamanho da fonte base no documento HTML
 * @param {string} value - 'small', 'normal' ou 'large'
 */
window.applyFontSize = function(value) {
    const fontSizeMap = {
        'small': '13px',
        'normal': '15px',
        'large': '17px'
    };
    const size = fontSizeMap[value] || '15px';
    document.documentElement.style.setProperty('--font-size-base', size);
    console.log(`[Appearance] Font size applied: ${value} (${size})`);
    
    // Armazenar no localStorage para persistência imediata entre abas
    const modules = JSON.parse(localStorage.getItem('mamcontrol_modules') || '{}');
    if (modules.font_size !== value) {
        modules.font_size = value;
        localStorage.setItem('mamcontrol_modules', JSON.stringify(modules));
    }
};

/**
 * Traduz labels de "Pessoas" e "Grupos" globalmente no sistema
 */
window.translateLabels = function() {
    try {
        const labels = JSON.parse(localStorage.getItem('mamcontrol_labels') || '{}');
        if (!labels.pessoas && !labels.grupos) return;

        const replacements = [];
        // IMPORTANTE: só aplica replace se o valor customizado for DIFERENTE do
        // termo original. Se o usuário define labels.grupos = 'Grupos/Departamentos',
        // o regex /Grupos/g matcharia o "Grupos" dentro do próprio replacement,
        // duplicando o texto a cada execução: "Grupos/Departamentos" →
        // "Grupos/Departamentos/Departamentos" → e por aí vai (não-idempotente).
        // Só aplica replace se o valor customizado for diferente do termo original.
        // O marker no body abaixo garante que mesmo se o regex matchar dentro do
        // próprio replacement (ex: 'Grupos/Departamentos' contém 'Grupos'), a
        // função não roda duas vezes na mesma página, evitando duplicação tipo
        // 'Grupos/Departamentos/Departamentos'.
        if (labels.pessoas && labels.pessoas !== 'Pessoas') {
            replacements.push({ search: /Pessoas/g, replace: labels.pessoas });
            const singularPessoa = labels.pessoas.endsWith('s') ? labels.pessoas.slice(0, -1) : labels.pessoas;
            replacements.push({ search: /Pessoa\b/g, replace: singularPessoa });
        }
        if (labels.grupos && labels.grupos !== 'Grupos') {
            replacements.push({ search: /Grupos/g, replace: labels.grupos });
            const singularGrupo = labels.grupos.endsWith('s') ? labels.grupos.slice(0, -1) : labels.grupos;
            replacements.push({ search: /Grupo\b/g, replace: singularGrupo });
        }

        if (replacements.length === 0) return;

        // Marker no body para evitar reaplicação em re-renders / navegação SPA-like.
        if (document.body.dataset.labelsTranslated === '1') return;
        document.body.dataset.labelsTranslated = '1';

        console.log('[Labels] Aplicando traduções personalizadas...');

        const walk = (node) => {
            // Evitar traduzir inputs de configuração na página de preferências
            if (node.id === 'config-label-pessoas' || node.id === 'config-label-grupos') return;

            if (node.nodeType === 3) { // Text node
                let text = node.nodeValue;
                let changed = false;
                replacements.forEach(r => {
                    if (r.search.test(text)) {
                        text = text.replace(r.search, r.replace);
                        changed = true;
                    }
                });
                if (changed) node.nodeValue = text;
            } else if (node.nodeType === 1 && 
                       node.nodeName !== 'SCRIPT' && 
                       node.nodeName !== 'STYLE' && 
                       node.nodeName !== 'TEXTAREA') {
                for (let i = 0; i < node.childNodes.length; i++) {
                    walk(node.childNodes[i]);
                }
            }
        };

        walk(document.body);
    } catch (e) {
        console.error('Erro ao traduzir labels:', e);
    }
};

// Inicialização da fonte
(function() {
    try {
        const modules = JSON.parse(localStorage.getItem('mamcontrol_modules') || '{}');
        const savedFontSize = modules.font_size || 'normal';
        window.applyFontSize(savedFontSize);
        
        // Tradução de labels
        // Aguarda um pouco para o DOM estar mais estável ou para outros scripts rodarem
        if (document.readyState === 'complete') {
            window.translateLabels();
        } else {
            window.addEventListener('load', () => window.translateLabels());
        }
    } catch (e) {
        console.error('Erro ao inicializar fonte/labels:', e);
    }
})();

// ============================================
// API SERVICE - Integração com Backend
// ============================================

class ApiService {
    constructor() {
        this.baseURL = CONFIG.API_URL;
    }

    // Headers padrão (Dínâmicos via LocalStorage/SessionStorage)
    getHeaders(includeAuth = true, omitContentType = false) {
        const tenantId = sessionStorage.getItem('mamcontrol_tenant') || 
                         localStorage.getItem('mamcontrol_tenant') || 
                         localStorage.getItem('tenant_id') || 
                         CONFIG.TENANT_ID;
                         
        const headers = {
            'X-Tenant-ID': tenantId
        };

        if (!omitContentType) {
            headers['Content-Type'] = 'application/json';
        }

        const token = sessionStorage.getItem('mamcontrol_accessToken') || 
                      localStorage.getItem('mamcontrol_accessToken');

        if (includeAuth && token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        return headers;
    }

    // Fazer requisição HTTP
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const isPublicAuthEndpoint = endpoint.startsWith('/auth/login') || endpoint.startsWith('/auth/refresh');
        
        const config = {
            ...options,
            headers: {
                ...this.getHeaders(!isPublicAuthEndpoint),
                ...options.headers
            }
        };

        try {
            const response = await fetch(url, config);

            // Garantir que a resposta é JSON antes de parsear
            const contentType = response.headers.get('content-type') || '';
            let data;
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                await response.text(); // consumir o body
                const apiError = new Error(`Erro ${response.status}: Serviço indisponível ou rota não encontrada`);
                apiError.status = response.status;
                throw apiError;
            }

            if (!response.ok) {
                if (response.status === 401 && !isPublicAuthEndpoint) {
                    const refreshed = await this.refreshAccessToken();
                    if (refreshed) {
                        const retryResponse = await fetch(url, config);
                        const retryContentType = retryResponse.headers.get('content-type') || '';
                        if (!retryContentType.includes('application/json')) {
                            const retryError = new Error(`Erro ${retryResponse.status}: Serviço indisponível`);
                            retryError.status = retryResponse.status;
                            throw retryError;
                        }
                        return await retryResponse.json();
                    }
                    this.logout();
                }
                const apiError = new Error(data.message || 'Erro na requisição');
                apiError.status = response.status;
                throw apiError;
            }

            return data;
        } catch (error) {
            console.error('Erro na requisição API:', error);
            throw error;
        }
    }

    // Autenticação
    async login(email, password) {
        const data = await this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
            requireAuth: false
        });

        console.log('=== Login API Response ===');
        console.log('data:', data);
        console.log('data.data:', data?.data);
        console.log('profilePermissions:', data?.data?.profilePermissions);
        
        if (data.success && data.data) {
            STATE.accessToken = data.data.accessToken;
            STATE.refreshToken = data.data.refreshToken;
            STATE.user = data.data.user;

            localStorage.setItem('mamcontrol_accessToken', STATE.accessToken);
            localStorage.setItem('mamcontrol_refreshToken', STATE.refreshToken);
            
            // Salvar dados do usuário incluindo permissões do perfil
            const userData = {
                ...data.data.user,
                profilePermissions: data.data.profilePermissions || [],
                profileName: data.data.profileName || null
            };
            console.log('Salvando userData:', userData);
            localStorage.setItem('mamcontrol_user', JSON.stringify(userData));
            localStorage.setItem('mamcontrol_loginTime', Date.now().toString());

            return data; // Retornar objeto completo com success
        }

        throw new Error(data.message || 'Credenciais inválidas');
    }

    async logout() {
        try {
            // Tentar fazer logout no backend
            await this.request('/auth/logout', {
                method: 'POST',
                requireAuth: true
            });
        } catch (error) {
            console.error('Erro ao fazer logout no servidor:', error);
            // Continuar mesmo se falhar no servidor
        } finally {
            // Sempre limpar o estado local
            STATE.accessToken = null;
            STATE.refreshToken = null;
            STATE.user = null;

            localStorage.removeItem('mamcontrol_accessToken');
            localStorage.removeItem('mamcontrol_refreshToken');
            localStorage.removeItem('mamcontrol_user');
            localStorage.removeItem('mamcontrol_tenant');
            localStorage.removeItem('mamcontrol_loginTime');
        }
    }

    async refreshAccessToken() {
        if (!STATE.refreshToken) return false;

        try {
            const data = await this.request('/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refreshToken: STATE.refreshToken }),
                requireAuth: false
            });

            if (data.success && data.data) {
                STATE.accessToken = data.data.accessToken;
                localStorage.setItem('mamcontrol_accessToken', STATE.accessToken);
                return true;
            }
        } catch (error) {
            console.error('Erro ao refresh token:', error);
        }

        return false;
    }

    // Pessoas
    async getPersons() {
        const data = await this.request('/persons');
        return data.success ? data.data : [];
    }

    async getPerson(id) {
        const data = await this.request(`/persons/${id}`);
        return data.success ? data.data : null;
    }

    async uploadPersonPhoto(personId, photoData) {
        if (!photoData || typeof photoData !== 'string' || !photoData.startsWith('data:image')) {
            return null;
        }
        const blob = this.dataURLtoBlob(photoData);
        if (!blob || blob.size === 0) {
            throw new Error('A imagem selecionada está vazia ou corrompida');
        }
        const formData = new FormData();
        formData.append('photo', blob, `person_${personId}.jpg`);

        const response = await fetch(`${this.baseURL}/persons/${personId}/photo`, {
            method: 'POST',
            headers: this.getHeaders(true, true),
            body: formData
        });

        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : {};
        if (!response.ok) {
            throw new Error(data.message || `Falha ao enviar foto (${response.status})`);
        }
        return data.data || data;
    }

    async createPerson(personData) {
        const photoData = personData.photo || personData.foto || personData.photo_base64;
        const payload = {};
        Object.keys(personData).forEach(key => {
            if (key === 'photo' || key === 'foto' || key === 'photo_base64') return;
            const val = personData[key];
            if (val !== null && val !== undefined) payload[key] = val;
        });

        const result = await this.request('/persons', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const created = result && result.data ? result.data : result;
        const personId = created?.id;

        if (photoData && personId) {
            await this.uploadPersonPhoto(personId, photoData);
        }

        return created;
    }

    async updatePerson(id, personData) {
        const photoData = personData.photo || personData.foto || personData.photo_base64;
        const payload = {};
        Object.keys(personData).forEach(key => {
            if (key === 'photo' || key === 'foto' || key === 'photo_base64') return;
            const val = personData[key];
            if (val !== null && val !== undefined) payload[key] = val;
        });

        const result = await this.request(`/persons/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });

        const updated = result && result.data ? result.data : result;

        if (photoData) {
            await this.uploadPersonPhoto(id, photoData);
        }

        return updated;
    }

    async deletePerson(id) {
        const data = await this.request(`/persons/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Visitantes
    async getVisitors() {
        const data = await this.request('/visitors');
        return data.success ? data.data : [];
    }

    async getVisitor(id) {
        const data = await this.request(`/visitors/${id}`);
        return data.success ? data.data : null;
    }

    async createVisitor(visitorData) {
        // Verificar foto - pode ser enviada como 'photo' ou 'photo_base64'
        const photoData = visitorData.photo || visitorData.photo_base64;
        const payload = {};
        Object.keys(visitorData).forEach(key => {
            if (key === 'photo') return; // Remove 'photo' antigo, mas mantém 'photo_base64'
            const val = visitorData[key];
            if (val !== null && val !== undefined) payload[key] = val;
        });

        // Adicionar photo_base64 ao payload para ser processado pelo backend
        if (photoData && typeof photoData === 'string' && photoData.startsWith('data:')) {
            payload.photo_base64 = photoData;
        }

        const result = await this.request('/visitors', {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const created = result && result.data ? result.data : result;

        return created;
    }

    async updateVisitor(id, visitorData) {
        // Verificar foto - pode ser enviada como 'photo' ou 'photo_base64'
        const photoData = visitorData.photo || visitorData.photo_base64;
        const payload = {};
        Object.keys(visitorData).forEach(key => {
            if (key === 'photo') return; // Remove 'photo' antigo, mas mantém 'photo_base64'
            const val = visitorData[key];
            if (val !== null && val !== undefined) payload[key] = val;
        });

        // Adicionar photo_base64 ao payload para ser processado pelo backend
        if (photoData && typeof photoData === 'string' && photoData.startsWith('data:')) {
            payload.photo_base64 = photoData;
        }

        const result = await this.request(`/visitors/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });

        const updated = result && result.data ? result.data : result;

        return updated;
    }

    async deleteVisitor(id) {
        const data = await this.request(`/visitors/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Grupos
    async getGroups(options = {}) {
        const { page = 1, limit = 1000 } = options;
        console.log('[DEBUG api.getGroups] Requisição para /groups com page:', page, 'limit:', limit);
        const url = limit ? `/groups?page=${page}&limit=${limit}` : `/groups`;
        const data = await this.request(url);
        console.log('[DEBUG api.getGroups] Resposta completa:', JSON.stringify(data));
        // Retornar o objeto completo para ter acesso à paginação
        return data;
    }

    async getGroup(id) {
        const data = await this.request(`/groups/${id}`);
        return data.success ? data.data : null;
    }

    async createGroup(groupData) {
        const data = await this.request('/groups', {
            method: 'POST',
            body: JSON.stringify(groupData)
        });
        return data.success ? data.data : null;
    }

    // Equipamentos
    async getEquipments() {
        const data = await this.request('/equipments');
        return data.success ? data.data : [];
    }

    // Veículos - busca todos os veículos
    async getAllVehicles(page = 1, limit = 50, search = '', status = '') {
        let url = `/vehicles?page=${page}&limit=${limit}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (status) url += `&status=${encodeURIComponent(status)}`;
        const data = await this.request(url);
        return data.success ? data : { success: true, data: [], pagination: { total: 0, totalPages: 0 } };
    }

    async updateGroup(id, groupData) {
        const data = await this.request(`/groups/${id}`, {
            method: 'PUT',
            body: JSON.stringify(groupData)
        });
        return data.success ? data.data : null;
    }

    async deleteGroup(id) {
        const data = await this.request(`/groups/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Empresas
    async getCompanies(active = true) {
        const params = active !== undefined ? `?active=${active}` : '';
        const data = await this.request(`/companies${params}`);
        return data.success ? data.data : [];
    }

    // Empresas - busca todas sem paginação
    async getAllCompanies() {
        const data = await this.request('/companies?limit=10000');
        return data.success ? data.data : [];
    }

    async getCompany(id) {
        const data = await this.request(`/companies/${id}`);
        return data.success ? data.data : null;
    }

    async createCompany(companyData) {
        const data = await this.request('/companies', {
            method: 'POST',
            body: JSON.stringify(companyData)
        });
        return data.success ? data.data : null;
    }

    async updateCompany(id, companyData) {
        const data = await this.request(`/companies/${id}`, {
            method: 'PUT',
            body: JSON.stringify(companyData)
        });
        return data.success ? data.data : null;
    }

    async deleteCompany(id) {
        const data = await this.request(`/companies/${id}`, { method: 'DELETE' });
        return data.success;
    }

    async restoreCompany(id) {
        const data = await this.request(`/companies/${id}/restore`, { method: 'POST' });
        return data.success;
    }

    async addCompanyOwner(companyId, ownerData) {
        const data = await this.request(`/companies/${companyId}/owners`, {
            method: 'POST',
            body: JSON.stringify(ownerData)
        });
        return data.success;
    }

    async removeCompanyOwner(companyId, personId) {
        const data = await this.request(`/companies/${companyId}/owners/${personId}`, {
            method: 'DELETE'
        });
        return data.success;
    }

    // Users (Operadores)
    async getUsers() {
        const data = await this.request('/auth/users');
        return data.success ? data.data : [];
    }

    async getUser(id) {
        const data = await this.request(`/auth/users/${id}`);
        return data.success ? data.data : null;
    }

    async createUser(userData) {
        const data = await this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData),
            requireAuth: true
        });
        return data.success ? data.data : null;
    }

    async updateUser(id, userData) {
        const data = await this.request(`/auth/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(userData)
        });
        return data.success ? data.data : null;
    }

    async deleteUser(id) {
        const data = await this.request(`/auth/users/${id}`, {
            method: 'DELETE'
        });
        return data.success;
    }

    // Dashboard/Reports
    async getDashboard() {
        const data = await this.request('/reports/dashboard');
        return data.success ? data.data : null;
    }

    // Relatório de Acessos Gerais
    async getAccessReport(filters = {}) {
        filters.limit = filters.limit || 2000;
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/access?${params}` : '/reports/access';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Estatísticas de Acessos
    async getAccessStats(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/access/stats?${params}` : '/reports/access/stats';
        const data = await this.request(url);
        return data.success ? data.data : null;
    }

    // Relatório de Acessos de Veículos (API)
    async getVehicleAccessReport(filters = {}) {
        filters.limit = filters.limit || 100000;
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/access/vehicles?${params}` : '/reports/access/vehicles';
        const data = await this.request(url);
        return data && data.success ? (data.data || []) : [];
    }


    // Estatísticas de Acessos de Veículos
    async getVehicleAccessStats(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/access/vehicles/stats?${params}` : '/reports/access/vehicles/stats';
        console.log('Fetching vehicle access stats from:', url);
        const data = await this.request(url);
        console.log('Vehicle access stats response:', data);
        return data.success ? data.data : null;
    }

    // Filtros para relatórios
    async getReportFilters() {
        const data = await this.request('/reports/filters');
        return data.success ? data.data : null;
    }

    // Filtros para relatórios de veículos
    async getVehicleReportFilters() {
        const data = await this.request('/reports/vehicles/filters');
        return data.success ? data.data : null;
    }

    // Download de arquivo de relatório com auth headers (evita download.json)
    async downloadReportFile(jobId, filename) {
        const url = `${this.baseURL}/report-jobs/${jobId}/download`;
        const resp = await fetch(url); // fetch interceptor adiciona auth headers automaticamente
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.message || `Erro ${resp.status} ao baixar relatório`);
        }
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename || `relatorio_${jobId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    }

    // Listar jobs de relatório do tenant
    async listReportJobs(page = 1, limit = 20) {
        const data = await this.request(`/report-jobs?page=${page}&limit=${limit}`);
        return data && data.success ? data : { data: [], total: 0 };
    }

    // Veículos atualmente no estacionamento (status = active)
    async getVehiclesInParking(search = '') {
        const params = search ? `?search=${encodeURIComponent(search)}` : '';
        const data = await this.request(`/vehicles/in-parking${params}`);
        return data && data.success ? { data: data.data || [], total: data.totalInParking || 0 } : { data: [], total: 0 };
    }

    // Registrar saída manual de veículo
    async registerManualExit(payload) {
        const data = await this.request('/vehicles/manual-exit', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        return data;
    }

    // Anotações de turno (por tenant)
    async getShiftNotes(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/shift-notes?${params}` : '/shift-notes';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }    

    async createShiftNote(payload) {
        return this.request('/shift-notes', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async updateShiftNote(id, payload) {
        return this.request(`/shift-notes/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
    }

    async deleteShiftNote(id) {
        return this.request(`/shift-notes/${id}`, { method: 'DELETE' });
    }

    async uploadShiftNoteAttachment(noteId, file) {
        const formData = new FormData();
        formData.append('file', file);
        const token = localStorage.getItem('mamcontrol_accessToken');
        const tenantId = this.tenantId || localStorage.getItem('mamcontrol_tenant');
        const response = await fetch(`${this.baseURL}/shift-notes/${noteId}/attachments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Tenant-ID': tenantId
            },
            body: formData
        });
        return response.json();
    }

    async deleteShiftNoteAttachment(attachmentId) {
        return this.request(`/shift-notes/attachments/${attachmentId}`, { method: 'DELETE' });
    }

    getShiftNoteAttachmentViewUrl(attachmentId) {
        const token = localStorage.getItem('mamcontrol_accessToken');
        const tenantId = this.tenantId || localStorage.getItem('mamcontrol_tenant');
        return `${this.baseURL}/shift-notes/attachments/${attachmentId}/view`;
    }

    getShiftNoteAttachmentDownloadUrl(attachmentId) {
        const token = localStorage.getItem('mamcontrol_accessToken');
        const tenantId = this.tenantId || localStorage.getItem('mamcontrol_tenant');
        return `${this.baseURL}/shift-notes/attachments/${attachmentId}/download`;
    }

    // Relatório de Pessoas
    async getPersonsReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/persons?${params}` : '/reports/persons';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Visitantes
    async getVisitorsReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/visitors?${params}` : '/reports/visitors';
        const data = await this.request(url);
        return data && data.success ? (data.data || []) : [];
    }

    // Relatório de Empresas
    async getCompaniesReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/companies?${params}` : '/reports/companies';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Acessos de Veículos
    async getVehiclesAccessReport(filters = {}) {
        filters.limit = filters.limit || 100000;
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/vehicles-access?${params}` : '/reports/vehicles-access';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Veículos
    async getVehiclesReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/vehicles?${params}` : '/reports/vehicles';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Estacionamentos
    async getParkingsReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/parkings?${params}` : '/reports/parkings';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Refeitórios/Cafeterias
    async getCafeteriasReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/cafeterias?${params}` : '/reports/cafeterias';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Horários
    async getSchedulesReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/schedules?${params}` : '/reports/schedules';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Relatório de Claviculário
    async getKeyholdersReport(filters = {}) {
        const params = new URLSearchParams(filters).toString();
        const url = params ? `/reports/keyholders?${params}` : '/reports/keyholders';
        const data = await this.request(url);
        return data.success ? data.data : [];
    }

    // Dados da empresa para relatórios (armazenados no banco)
    async getReportCompany() {
        const data = await this.request('/config/report-company');
        return data.success ? data.data : null;
    }

    async updateReportCompany(companyData) {
        const data = await this.request('/config/report-company', {
            method: 'PUT',
            body: JSON.stringify(companyData)
        });
        return data.success;
    }

    // Estacionamentos
    async getParkings(page = 1, limit = 10000) {
        const data = await this.request(`/parkings?page=${page}&limit=${limit}`);
        return data.success ? (data.data || data) : [];
    }

    async getParking(id) {
        const data = await this.request(`/parkings/${id}`);
        return data.success ? data.data : null;
    }

    async createParking(parkingData) {
        const data = await this.request('/parkings', {
            method: 'POST',
            body: JSON.stringify(parkingData)
        });
        return data.success ? data.data : null;
    }

    async updateParking(id, parkingData) {
        const data = await this.request(`/parkings/${id}`, {
            method: 'PUT',
            body: JSON.stringify(parkingData)
        });
        return data.success ? data.data : null;
    }

    async deleteParking(id) {
        const data = await this.request(`/parkings/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Vagas de estacionamento
    async getParkingSpots(parkingId) {
        const data = await this.request(`/parkings/${parkingId}/spots`);
        return data.success ? data.data : [];
    }

    async createParkingSpot(parkingId, spotData) {
        const data = await this.request(`/parkings/${parkingId}/spots`, {
            method: 'POST',
            body: JSON.stringify(spotData)
        });
        return data.success ? data.data : null;
    }

    async deleteParkingSpot(parkingId, spotId) {
        const data = await this.request(`/parkings/${parkingId}/spots/${spotId}`, { method: 'DELETE' });
        return data.success;
    }

    // Feriados
    async getHolidays() {
        const data = await this.request('/holidays');
        return data.success ? data.data : [];
    }

    async getHoliday(id) {
        const data = await this.request(`/holidays/${id}`);
        return data.success ? data.data : null;
    }

    async createHoliday(holidayData) {
        const data = await this.request('/holidays', {
            method: 'POST',
            body: JSON.stringify(holidayData)
        });
        return data.success ? data.data : null;
    }

    async updateHoliday(id, holidayData) {
        const data = await this.request(`/holidays/${id}`, {
            method: 'PUT',
            body: JSON.stringify(holidayData)
        });
        return data.success ? data.data : null;
    }

    async deleteHoliday(id) {
        const data = await this.request(`/holidays/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Horários
    async getSchedules() {
        const data = await this.request('/schedules');
        return data;
    }

    async getSchedule(id) {
        const data = await this.request(`/schedules/${id}`);
        return data;
    }

    async createSchedule(scheduleData) {
        const data = await this.request('/schedules', {
            method: 'POST',
            body: JSON.stringify(scheduleData)
        });
        // Retornar o objeto completo para poder verificar success
        return data;
    }

    async updateSchedule(id, scheduleData) {
        const data = await this.request(`/schedules/${id}`, {
            method: 'PUT',
            body: JSON.stringify(scheduleData)
        });
        return data;
    }

    async deleteSchedule(id) {
        const data = await this.request(`/schedules/${id}`, { method: 'DELETE' });
        return data;
    }

    // Regras de Acesso
    // accessTarget: 'persons' | 'vehicles' | undefined (ambos)
    // Sem o filtro, a aba de Pessoas mostrava regras de Veículos misturadas.
    async getAccessRules(accessTarget) {
        const url = accessTarget
            ? `/access-rules?access_target=${encodeURIComponent(accessTarget)}`
            : '/access-rules';
        const data = await this.request(url);
        return data;
    }

    async getAccessRule(id) {
        const data = await this.request(`/access-rules/${id}`);
        return data;
    }

    async createAccessRule(ruleData) {
        const data = await this.request('/access-rules', {
            method: 'POST',
            body: JSON.stringify(ruleData)
        });
        return data;
    }

    async updateAccessRule(id, ruleData) {
        const data = await this.request(`/access-rules/${id}`, {
            method: 'PUT',
            body: JSON.stringify(ruleData)
        });
        return data;
    }

    async deleteAccessRule(id) {
        const data = await this.request(`/access-rules/${id}`, { method: 'DELETE' });
        return data;
    }

    // Refeitórios
    async getCafeterias() {
        const data = await this.request('/cafeterias');
        return data.success ? data.data : [];
    }

    async getCafeteria(id) {
        const data = await this.request(`/cafeterias/${id}`);
        return data.success ? data.data : null;
    }

    async createCafeteria(cafeteriaData) {
        const data = await this.request('/cafeterias', {
            method: 'POST',
            body: JSON.stringify(cafeteriaData)
        });
        return data.success ? data.data : null;
    }

    async updateCafeteria(id, cafeteriaData) {
        const data = await this.request(`/cafeterias/${id}`, {
            method: 'PUT',
            body: JSON.stringify(cafeteriaData)
        });
        return data.success ? data.data : null;
    }

    async deleteCafeteria(id) {
        const data = await this.request(`/cafeterias/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Claviculários
    async getKeyholders() {
        const data = await this.request('/keyholders');
        return data.success ? data.data : [];
    }

    async getKeyholder(id) {
        const data = await this.request(`/keyholders/${id}`);
        return data.success ? data.data : null;
    }

    async createKeyholder(keyholderData) {
        const data = await this.request('/keyholders', {
            method: 'POST',
            body: JSON.stringify(keyholderData)
        });
        return data.success ? data.data : null;
    }

    async updateKeyholder(id, keyholderData) {
        const data = await this.request(`/keyholders/${id}`, {
            method: 'PUT',
            body: JSON.stringify(keyholderData)
        });
        return data.success ? data.data : null;
    }

    async deleteKeyholder(id) {
        const data = await this.request(`/keyholders/${id}`, { method: 'DELETE' });
        return data.success;
    }

    // Converter dataURL para Blob sem fetch (evita bloqueio de CSP em data:)
    dataURLtoBlob(dataURL) {
        const [header, base64] = dataURL.split(',');
        if (!base64) {
            throw new Error('Imagem inválida');
        }
        const mimeMatch = header.match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new Blob([bytes], { type: mime });
    }
}

const api = new ApiService();
window.api = api;

// ============================================
// HISTÓRICO DE RELATÓRIOS
// ============================================
const RelatorioHistorico = {
    _injected: false,

    _nomes: {
        access: 'Acessos de Pessoas',
        access_por_empresa: 'Presenças por Empresa (Pessoas)',
        vehicles: 'Acessos de Veículos',
        vehicles_por_empresa: 'Presenças por Empresa (Veículos)',
        persons: 'Cadastro de Pessoas',
        visitors: 'Cadastro de Visitantes',
        companies: 'Cadastro de Empresas',
        encomendas: 'Encomendas',
    },

    _injectModal() {
        if (this._injected) return;
        this._injected = true;
        const html = `
        <div id="relHistoricoModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;align-items:center;justify-content:center;">
          <div style="background:#fff;border-radius:14px;width:min(700px,95vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25);">
            <div style="padding:20px 24px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;">
              <h3 style="margin:0;font-size:1.1rem;color:#1e293b;"><i class="fas fa-history"></i> Histórico de Relatórios</h3>
              <button onclick="RelatorioHistorico.fechar()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#94a3b8;">&times;</button>
            </div>
            <p style="margin:12px 24px 0;color:#64748b;font-size:0.88rem;">Os relatórios abaixo foram gerados anteriormente. Clique em <strong>Regerar</strong> para criar um novo PDF com os mesmos filtros.</p>
            <div style="padding:16px 24px;overflow-y:auto;flex:1;" id="relHistoricoLista">
              <p style="color:#94a3b8;text-align:center;padding:30px;">Carregando...</p>
            </div>
            <div style="padding:16px 24px;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px;">
              <button onclick="RelatorioHistorico.fechar()" style="padding:8px 18px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-size:0.9rem;color:#475569;">Fechar</button>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    },

    async abrir(onRegerar) {
        this._injectModal();
        this._onRegerar = onRegerar || null;
        document.getElementById('relHistoricoModal').style.display = 'flex';
        await this._carregar();
    },

    fechar() {
        const el = document.getElementById('relHistoricoModal');
        if (el) el.style.display = 'none';
    },

    async _carregar() {
        const lista = document.getElementById('relHistoricoLista');
        lista.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:30px;">Carregando...</p>';
        try {
            const res = await api.listReportJobs(1, 30);
            const jobs = res.data || [];
            if (jobs.length === 0) {
                lista.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:30px;">Nenhum relatório gerado ainda.</p>';
                return;
            }
            lista.innerHTML = jobs.map(job => {
                const nome = this._nomes[job.report_type] || job.report_type;
                const data = job.created_at ? new Date(job.created_at).toLocaleString('pt-BR') : '-';
                const orientacao = job.orientation === 'landscape' ? 'Paisagem' : 'Retrato';
                let filtrosTexto = '-';
                try {
                    const f = typeof job.filters === 'string' ? JSON.parse(job.filters) : (job.filters || {});
                    const partes = [];
                    if (f.startDate) partes.push('De: ' + f.startDate.split('T')[0]);
                    if (f.endDate)   partes.push('Até: ' + f.endDate.split('T')[0]);
                    if (f.status)    partes.push('Status: ' + f.status);
                    if (f.groupId)   partes.push('Grupo: ' + f.groupId);
                    if (f.companyId) partes.push('Empresa: ' + f.companyId);
                    if (partes.length) filtrosTexto = partes.join(' | ');
                } catch(e) {}
                const statusColor = job.status === 'completed' ? '#22c55e' : job.status === 'failed' ? '#ef4444' : '#f59e0b';
                const statusLabel = job.status === 'completed' ? 'Concluído' : job.status === 'failed' ? 'Falhou' : 'Processando';
                return `<div style="padding:14px 0;border-bottom:1px solid #f1f5f9;">
                  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
                    <div style="flex:1;">
                      <div style="font-weight:600;color:#1e293b;font-size:0.95rem;">${nome}</div>
                      <div style="font-size:0.82rem;color:#64748b;margin-top:3px;">${filtrosTexto}</div>
                      <div style="font-size:0.8rem;color:#94a3b8;margin-top:2px;">${data} • ${orientacao} • <span style="color:${statusColor}">${statusLabel}</span>${job.total_records ? ' • ' + job.total_records + ' registros' : ''}</div>
                    </div>
                    <button onclick="RelatorioHistorico._regerar('${job.id}')" style="padding:7px 14px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;white-space:nowrap;flex-shrink:0;">
                      <i class="fas fa-redo"></i> Regerar
                    </button>
                  </div>
                </div>`;
            }).join('');
        } catch(e) {
            lista.innerHTML = '<p style="color:#ef4444;text-align:center;padding:30px;">Erro ao carregar histórico.</p>';
        }
    },

    async _regerar(jobId) {
        const lista = document.getElementById('relHistoricoLista');
        try {
            // Buscar job original para obter filtros
            const jobRes = await api.request(`/report-jobs/${jobId}`);
            if (!jobRes || !jobRes.success) throw new Error('Job não encontrado');
            const job = jobRes.data;
            const filters = typeof job.filters === 'string' ? JSON.parse(job.filters || '{}') : (job.filters || {});

            // Criar novo job com mesmos filtros
            const resp = await api.request('/report-jobs', {
                method: 'POST',
                body: JSON.stringify({ report_type: job.report_type, orientation: job.orientation || 'portrait', filters })
            });
            if (!resp || !resp.success) throw new Error(resp?.message || 'Erro ao criar job');

            const novoJobId = resp.data.id;
            this.fechar();

            // Se houver callback, delegar ao caller (para mostrar o status na página)
            if (this._onRegerar) {
                this._onRegerar(novoJobId, job.report_type);
                return;
            }

            // Senão, mostrar alerta com polling simples
            const statusMsg = 'Relatório em processamento... (ID: ' + novoJobId + ')';
            alert(statusMsg + '\nO PDF estará disponível em instantes.');
        } catch(e) {
            alert('Erro ao regerar: ' + e.message);
        }
    }
};
window.RelatorioHistorico = RelatorioHistorico;

// ============================================
// STORAGE MANAGER - Gerenciamento de Dados
// ============================================

class StorageManager {
    constructor() {
        this.prefix = CONFIG.STORAGE_PREFIX;
        this.init();
    }

    init() {
        if (!this.get('initialized')) {
            this.set('initialized', true);
            this.set('labels', CONFIG.DEFAULT_LABELS);
            this.set('pessoas', []);
            this.set('visitantes', []);
            this.set('grupos', []);
            this.set('empresas', []);
            this.set('last_matricula', 0);
            this.set('settings', {
                theme: 'light',
                language: 'pt-BR',
                auto_backup: true
            });
        }
    }

    // Métodos básicos de armazenamento
    set(key, value) {
        localStorage.setItem(this.prefix + key, JSON.stringify(value));
        return value;
    }

    get(key) {
        const data = localStorage.getItem(this.prefix + key);
        return data ? JSON.parse(data) : null;
    }

    remove(key) {
        localStorage.removeItem(this.prefix + key);
    }

    clear() {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(this.prefix)) {
                localStorage.removeItem(key);
            }
        });
        this.init();
    }

    // Métodos específicos para cada entidade - Agora usando API
    async savePessoa(pessoa) {
        try {
        // Mapear campos do frontend (pt-BR) para os nomes esperados pelo backend (en)
                const payload = {
                    registration_number: pessoa.matricula || pessoa.registrationNumber || null,
                    name: pessoa.nome || pessoa.name || null,
                    cpf: pessoa.cpf || null,
                    rg: pessoa.rg || null,
                    birth_date: pessoa.dataNascimento || pessoa.birth_date || null,
                    gender: pessoa.genero || pessoa.gender || null,
                    marital_status: pessoa.estadoCivil || null,
                    profession: pessoa.profissao || pessoa.profession || null,
                    position: pessoa.cargo || pessoa.position || null,
                    admission_date: pessoa.dataAdmissao || pessoa.admission_date || null,
                    phone: pessoa.telefone || pessoa.phone || null,
                    cellphone: pessoa.celular || pessoa.cellphone || '',
                    cellphone_ddi: pessoa.cellphone_ddi || '+55',
                    email: pessoa.email || '',
                    father_name: pessoa.nomePai || pessoa.father_name || null,
                    mother_name: pessoa.nomeMae || pessoa.mother_name || null,
                    address: pessoa.endereco || pessoa.address || null,
                    neighborhood: pessoa.bairro || pessoa.neighborhood || null,
                    city: pessoa.cidade || pessoa.city || null,
                    state: pessoa.estado || pessoa.state || null,
                    cep: pessoa.cep || null,
                    street_number: pessoa.numero || null,
                    address_complement: pessoa.complemento || null,
                    // support multiple groups - use Array.isArray to handle empty arrays correctly
                    group_ids: (Array.isArray(pessoa.grupoIds) && pessoa.grupoIds.length > 0) ? pessoa.grupoIds : (Array.isArray(pessoa.group_ids) && pessoa.group_ids.length > 0) ? pessoa.group_ids : (pessoa.grupoId ? [pessoa.grupoId] : []),
                    company_id: pessoa.empresaId || pessoa.company_id || null,
                    status: pessoa.status || 'active',
                    photo: pessoa.foto || pessoa.photo || null,
                    foto: pessoa.foto || pessoa.photo_base64 || null,
                    photo_base64: pessoa.foto || pessoa.photo_base64 || null,
                    // Additional fields
                    nationality: pessoa.nacionalidade || null,
                    naturality: pessoa.naturalidade || null,
                    extension: pessoa.ramal || null,
                    // Mobile authentication and permissions
                    password: pessoa.mobile_password || null,
                    mobile_permissions: pessoa.mobile_permissions || null,
                    // Vehicle data - mapear para nomes em inglês esperados pelo backend
                    vehicle: pessoa.veiculo && Object.keys(pessoa.veiculo).some(k => pessoa.veiculo[k]) ? {
                        license_plate: pessoa.veiculo.placa || null,
                        brand: pessoa.veiculo.marca || null,
                        model: pessoa.veiculo.modelo || null,
                        color: pessoa.veiculo.cor || null,
                        year: pessoa.veiculo.ano || null,
                        parking_id: pessoa.veiculo.parking_id || pessoa.veiculo.vagaId || null,
                        company_id: pessoa.veiculo.company_id || pessoa.veiculo.empresaId || null,
                        spot_number: pessoa.veiculo.spot_number || pessoa.veiculo.vagaInfo || null,
                        tag_number: pessoa.veiculo.tag_number || pessoa.veiculo.tagNumero || null
                    } : null,
                    // Vehicles array - mapear para nomes em inglês esperados pelo backend
                    vehicles: pessoa.veiculos && Array.isArray(pessoa.veiculos) ? pessoa.veiculos.map(v => ({
                        license_plate: v.placa || v.license_plate || null,
                        brand: v.marca || v.brand || null,
                        model: v.modelo || v.model || null,
                        color: v.cor || v.color || null,
                        year: v.ano || v.year || null,
                        parking_id: v.parking_id || v.vagaId || null,
                        company_id: v.company_id || v.empresaId || null,
                        spot_number: v.spot_number || v.vagaInfo || null,
                        tag_number: v.tag_number || v.tagNumero || null
                    })) : []
                };

        if (pessoa.id) {
                const updated = await api.updatePerson(pessoa.id, payload);
                return updated || pessoa;
        } else {
                const created = await api.createPerson(payload);
                return created || pessoa;
            }
        } catch (error) {
            console.error('Erro ao salvar pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar pessoa');
            throw error;
        }
    }

    async getPessoa(id) {
        try {
            const response = await api.getPerson(id);
            console.log('[DEBUG] getPessoa - API response:', response);
            return response;
        } catch (error) {
            console.error('Erro ao buscar pessoa:', error);
            return null;
        }
    }

    async deletePessoa(id) {
        try {
            return await api.deletePerson(id);
        } catch (error) {
            console.error('Erro ao deletar pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar pessoa');
            throw error;
        }
    }

    async getPessoas() {
        try {
            return await api.getPersons();
        } catch (error) {
            console.error('Erro ao buscar pessoas:', error);
            return [];
        }
    }

    async saveVisitante(visitante) {
        try {
            // Mapear campos do frontend (pt-BR) para os nomes esperados pelo backend
                const payload = {
                    name: visitante.nome || visitante.name || null,
                    document: visitante.documento || visitante.document || null,
                    rg: visitante.rg || null,
                    cellphone: visitante.celular || visitante.cellphone || null,
                    email: visitante.email || null,
                    visitor_company: visitante.empresa || visitante.visitor_company || null,
                    visited_person_id: visitante.pessoaVisitadaId || visitante.visited_person_id || null,
                    visited_company_id: visitante.empresaVisitadaId || visitante.visited_company_id || null,
                    reason: visitante.motivo || visitante.reason || null,
                    entry_date: visitante.entry_date || visitante.dataEntrada || null,
                    exit_date: visitante.exit_date || visitante.dataSaida || null,
                    liberation_type: visitante.liberation_type || visitante.tipoLiberacao || null,
                    period_start: visitante.period_start || visitante.periodoInicio || null,
                    period_end: visitante.period_end || visitante.periodoFim || null,
                    status: visitante.status || null,
                    photo: visitante.photo || visitante.foto || visitante.photo_url || visitante.photo_base64 || null
                };

            if (visitante.id) {
                const updated = await api.updateVisitor(visitante.id, payload);
                return updated || visitante;
            } else {
                const created = await api.createVisitor(payload);
                return created || visitante;
            }
        } catch (error) {
            console.error('Erro ao salvar visitante:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar visitante');
            throw error;
        }
    }

    async getVisitante(id) {
        try {
            return await api.getVisitor(id);
        } catch (error) {
            console.error('Erro ao buscar visitante:', error);
            return null;
        }
    }

    async deleteVisitante(id) {
        try {
            return await api.deleteVisitor(id);
        } catch (error) {
            console.error('Erro ao deletar visitante:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar visitante');
            throw error;
        }
    }

    async getVisitantes() {
        try {
            return await api.getVisitors();
        } catch (error) {
            console.error('Erro ao buscar visitantes:', error);
            return [];
        }
    }

    async saveGrupo(grupo) {
        try {
            console.log('storage.saveGrupo - grupo recebido:', grupo);
            // O tipo já deve vir em inglês do frontend, mas vamos mapear por segurança
                const tipo = grupo.tipo || grupo.type || null;
                const groupData = {
                    name: grupo.nome || grupo.name || null,
                    type: tipo && tipo.trim() !== '' ? tipo : null,
                    description: grupo.descricao || grupo.description || null,
                    emails: grupo.emails || []
                };
            console.log('storage.saveGrupo - groupData enviado para API:', groupData);
            
            if (grupo.id) {
                console.log('storage.saveGrupo - atualizando grupo ID:', grupo.id);
                const updated = await api.updateGroup(grupo.id, groupData);
                console.log('storage.saveGrupo - resposta da API (update):', updated);
                return { ...grupo, ...updated, nome: updated.name };
        } else {
                console.log('storage.saveGrupo - criando novo grupo');
                const created = await api.createGroup(groupData);
                console.log('storage.saveGrupo - resposta da API (create):', created);
                return { ...grupo, ...created, nome: created.name };
            }
        } catch (error) {
            console.error('Erro ao salvar grupo:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar grupo');
            throw error;
        }
    }

    async getGrupo(id) {
        try {
            return await api.getGroup(id);
        } catch (error) {
            console.error('Erro ao buscar grupo:', error);
            return null;
        }
    }

    async deleteGrupo(id) {
        try {
            return await api.deleteGroup(id);
        } catch (error) {
            console.error('Erro ao deletar grupo:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar grupo');
            throw error;
        }
    }

    async createGrupo(groupData) {
        try {
            console.log('storage.createGrupo - dados recebidos:', groupData);
            const data = await api.createGroup(groupData);
            console.log('storage.createGrupo - resposta da API:', data);
            return data?.data || data;
        } catch (error) {
            console.error('Erro ao criar grupo:', error);
            throw error;
        }
    }

    async updateGrupo(id, groupData) {
        try {
            console.log('storage.updateGrupo - ID:', id, 'dados:', groupData);
            const data = await api.updateGroup(id, groupData);
            console.log('storage.updateGrupo - resposta da API:', data);
            return data?.data || data;
        } catch (error) {
            console.error('Erro ao atualizar grupo:', error);
            throw error;
        }
    }

    async getGrupos(options = {}) {
        try {
            console.log('[DEBUG getGrupos] Iniciando...');
            // Buscar todos os grupos de uma vez (limit alto)
            const { page = 1, limit = 1000 } = options;
            console.log('[DEBUG getGrupos] page:', page, 'limit:', limit);
            
            const data = await api.getGroups({ page, limit });
            console.log('[DEBUG getGrupos] Resposta da API:', JSON.stringify(data));
            
            // A API retorna { success, data: [...], pagination: {...} }
            // Verificar se é resposta formatada ou array direto
            if (data && data.success && data.data) {
                // Resposta formatada pelo backend
                console.log('[DEBUG getGrupos] Dados Formatados - total:', data.data.length);
                return data;
            } else if (Array.isArray(data)) {
                // Array direto - criar resposta formatada
                console.log('[DEBUG getGrupos] Array direto - total:', data.length);
                return {
                    success: true,
                    data: data,
                    pagination: {
                        page: 1,
                        limit: 100,
                        total: data.length,
                        totalPages: 1
                    }
                };
            }
            console.log('[DEBUG getGrupos] Dados inválidos ou vazios:', data);
            return { success: true, data: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
        } catch (error) {
            console.error('[DEBUG getGrupos] Erro ao buscar grupos:', error);
            return { success: true, data: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
        }
    }

    async saveEmpresa(empresa) {
        try {
            // Mapear campos do frontend para o formato esperado pelo backend
            // Tratar group_ids corretamente (suporta múltiplos grupos)
            const groupIdsValue = empresa.groupIds || empresa.group_ids || [];
            console.log('Group IDs recebido:', groupIdsValue);
            
            // Garantir que é um array de números
            let groupIdsFinal = [];
            if (Array.isArray(groupIdsValue)) {
                groupIdsFinal = groupIdsValue
                    .map(id => parseInt(id))
                    .filter(id => !isNaN(id));
            }
            console.log('Group IDs final:', groupIdsFinal);
            
            const companyData = {
                corporate_name: empresa.razaoSocial || empresa.corporate_name,
                trading_name: empresa.nomeFantasia || empresa.trading_name,
                cnpj: empresa.cnpj,
                phone: empresa.telefone || empresa.phone,
                email: empresa.email,
                address: empresa.endereco || empresa.address,
                group_ids: groupIdsFinal,
                notification_emails: empresa.notification_emails || []
            };
            
            let savedCompany;
            if (empresa.id) {
                savedCompany = await api.updateCompany(empresa.id, companyData);
            } else {
                savedCompany = await api.createCompany(companyData);
            }
            
            // Depois de salvar, adicionar proprietários se houver
            if (empresa.proprietarios && Array.isArray(empresa.proprietarios) && empresa.proprietarios.length > 0) {
                await this.addEmpresaProprietarios(savedCompany.id, empresa.proprietarios);
            }
            
            return { ...empresa, ...savedCompany, razaoSocial: savedCompany.corporate_name, nomeFantasia: savedCompany.trading_name };
        } catch (error) {
            console.error('Erro ao salvar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar empresa');
            throw error;
        }
    }
    
    async addEmpresaProprietarios(companyId, proprietarios) {
        try {
            // Primeiro, buscar a empresa atual para obter os proprietários existentes
            const company = await api.getCompany(companyId);
            if (company && company.owners && Array.isArray(company.owners)) {
                // Remover todos os proprietários existentes
                for (const owner of company.owners) {
                    try {
                        await api.removeCompanyOwner(companyId, owner.id);
                    } catch (error) {
                        console.warn('Erro ao remover proprietário:', error);
                    }
                }
            }
            // Depois, adicionar os novos proprietários
            for (const personId of proprietarios) {
                try {
                    await api.addCompanyOwner(companyId, { person_id: personId });
                } catch (error) {
                    console.warn('Erro ao adicionar proprietário:', error);
                }
            }
        } catch (error) {
            console.error('Erro ao gerenciar proprietários:', error);
            // Não propagar o erro, pois a empresa já foi salva
        }
    }

    async getEmpresa(id) {
        try {
            return await api.getCompany(id);
        } catch (error) {
            console.error('Erro ao buscar empresa:', error);
            return null;
        }
    }

    async deleteEmpresa(id) {
        try {
            return await api.deleteCompany(id);
        } catch (error) {
            console.error('Erro ao inativar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao inativar empresa');
            throw error;
        }
    }

    async restoreEmpresa(id) {
        try {
            return await api.restoreCompany(id);
        } catch (error) {
            console.error('Erro ao reativar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao reativar empresa');
            throw error;
        }
    }

    async getEmpresas(active = true) {
        try {
            return await api.getCompanies(active);
        } catch (error) {
            console.error('Erro ao buscar empresas:', error);
            return [];
        }
    }

    // Labels personalizados
    updateLabels() {
        const labels = this.get('labels') || CONFIG.DEFAULT_LABELS;
        
        // Atualizar todos os elementos com classe label-pessoas
        document.querySelectorAll('.label-pessoas').forEach(el => {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = labels.pessoas;
            } else {
                el.textContent = labels.pessoas;
            }
        });
        
        // Atualizar todos os elementos com classe label-grupos
        document.querySelectorAll('.label-grupos').forEach(el => {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = labels.grupos;
            } else {
                el.textContent = labels.grupos;
            }
        });
        
        console.log('Labels atualizados:', labels);
    }

    setLabel(type, value) {
        const labels = this.get('labels') || CONFIG.DEFAULT_LABELS;
        labels[type] = value;
        this.set('labels', labels);
        this.updateLabels();
    }

    // Geração de matrícula
    generateMatricula() {
        let last = this.get('last_matricula') || 0;
        last++;
        this.set('last_matricula', last);
        
        const sequential = last.toString().padStart(4, '0');
        return CONFIG.MATRICULA_PREFIX + sequential;
    }

    // Backup e Restauração
    backupData() {
        const data = {};
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(this.prefix)) {
                data[key] = localStorage.getItem(key);
            }
        });
        
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mamcontrol-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        return true;
    }

    restoreData(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    Object.keys(data).forEach(key => {
                        localStorage.setItem(key, data[key]);
                    });
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    // Estatísticas
    getStats() {
        return {
            pessoas: (this.get('pessoas') || []).length,
            visitantes: (this.get('visitantes') || []).length,
            grupos: (this.get('grupos') || []).length,
            empresas: (this.get('empresas') || []).length
        };
    }

    // ============================================
    // MÉTODOS DE ESTACIONAMENTO
    // ============================================
    
    async saveEstacionamento(estacionamento) {
        try {
            const payload = {
                name: estacionamento.name,
                type: estacionamento.type,
                total_spots: estacionamento.total_spots || null,
                active: estacionamento.active ? 1 : 0
            };
            
            // Adicionar distribuição de vagas por empresa se existir
            if (estacionamento.empresas && Array.isArray(estacionamento.empresas)) {
                payload.empresas = estacionamento.empresas;
            }
            
            if (estacionamento.id) {
                const updated = await api.updateParking(estacionamento.id, payload);
                return updated;
            } else {
                const created = await api.createParking(payload);
                return created;
            }
        } catch (error) {
            console.error('Erro ao salvar estacionamento:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar estacionamento');
            throw error;
        }
    }

    async getEstacionamento(id) {
        try {
            return await api.getParking(id);
        } catch (error) {
            console.error('Erro ao buscar estacionamento:', error);
            return null;
        }
    }

    async deleteEstacionamento(id) {
        try {
            return await api.deleteParking(id);
        } catch (error) {
            console.error('Erro ao deletar estacionamento:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar estacionamento');
            throw error;
        }
    }

    async getEstacionamentos() {
        try {
            return await api.getParkings();
        } catch (error) {
            console.error('Erro ao buscar estacionamentos:', error);
            return [];
        }
    }

    async getEstacionamentosPagination(page = 1, limit = 10) {
        try {
            return await api.getParkings(page, limit);
        } catch (error) {
            console.error('Erro ao buscar paginação de estacionamentos:', error);
            return { data: [], pagination: {} };
        }
    }

    async addVaga(estacionamentoId, vaga) {
        try {
            return await api.createParkingSpot(estacionamentoId, vaga);
        } catch (error) {
            console.error('Erro ao adicionar vaga:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao adicionar vaga');
            throw error;
        }
    }

    async addVagasBulk(estacionamentoId, vagasData) {
        try {
            return await api.createParkingSpot(estacionamentoId, vagasData);
        } catch (error) {
            console.error('Erro ao adicionar vagas:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao adicionar vagas');
            throw error;
        }
    }

    async deleteVaga(estacionamentoId, vagaId) {
        try {
            return await api.deleteParkingSpot(estacionamentoId, vagaId);
        } catch (error) {
            console.error('Erro ao deletar vaga:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar vaga');
            throw error;
        }
    }

    async getSpots(estacionamentoId) {
        try {
            return await api.getParkingSpots(estacionamentoId);
        } catch (error) {
            console.error('Erro ao buscar vagas:', error);
            return [];
        }
    }

    // ============================================
    // MÉTODOS DE FERIADOS
    // ============================================
    
    async saveFeriado(feriado) {
        try {
            const payload = {
                name: feriado.name,
                date: feriado.date,
                type: feriado.type || 'national',
                description: feriado.description || null
            };
            
            if (feriado.id) {
                const updated = await api.updateHoliday(feriado.id, payload);
                return updated;
            } else {
                const created = await api.createHoliday(payload);
                return created;
            }
        } catch (error) {
            console.error('Erro ao salvar feriado:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar feriado');
            throw error;
        }
    }

    async getFeriados() {
        try {
            return await api.getHolidays();
        } catch (error) {
            console.error('Erro ao buscar feriados:', error);
            return [];
        }
    }

    async deleteFeriado(id) {
        try {
            return await api.deleteHoliday(id);
        } catch (error) {
            console.error('Erro ao deletar feriado:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar feriado');
            throw error;
        }
    }

    // ============================================
    // MÉTODOS DE HORÁRIOS
    // ============================================
    
    async saveHorario(horario) {
        try {
            const payload = {
                name: horario.name,
                type: horario.type || 'general',
                description: horario.description || null,
                ranges: horario.ranges || []
            };
            
            if (horario.id) {
                const updated = await api.updateSchedule(horario.id, payload);
                return updated;
            } else {
                const created = await api.createSchedule(payload);
                return created;
            }
        } catch (error) {
            console.error('Erro ao salvar horário:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar horário');
            throw error;
        }
    }

    async getHorarios() {
        try {
            return await api.getSchedules();
        } catch (error) {
            console.error('Erro ao buscar horários:', error);
            return [];
        }
    }

    async deleteHorario(id) {
        try {
            return await api.deleteSchedule(id);
        } catch (error) {
            console.error('Erro ao deletar horário:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar horário');
            throw error;
        }
    }

    // ============================================
    // MÉTODOS DE REFEITÓRIO
    // ============================================
    
    async saveRefeitorio(refeitorio) {
        try {
            const payload = {
                name: refeitorio.name,
                location: refeitorio.location || null,
                capacity: refeitorio.capacity || null,
                schedule_id: refeitorio.schedule_id || null,
                active: refeitorio.active ? 1 : 0
            };
            
            if (refeitorio.id) {
                const updated = await api.updateCafeteria(refeitorio.id, payload);
                return updated;
            } else {
                const created = await api.createCafeteria(payload);
                return created;
            }
        } catch (error) {
            console.error('Erro ao salvar refeitório:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar refeitório');
            throw error;
        }
    }

    async getRefeitorios() {
        try {
            return await api.getCafeterias();
        } catch (error) {
            console.error('Erro ao buscar refeitórios:', error);
            return [];
        }
    }

    async deleteRefeitorio(id) {
        try {
            return await api.deleteCafeteria(id);
        } catch (error) {
            console.error('Erro ao deletar refeitório:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar refeitório');
            throw error;
        }
    }

    // ============================================
    // MÉTODOS DE CLAVICULÁRIO
    // ============================================
    
    async saveClaviculario(claviculario) {
        try {
            const payload = {
                name: claviculario.name,
                location: claviculario.location || null,
                capacity: claviculario.capacity || null,
                description: claviculario.description || null,
                active: claviculario.active ? 1 : 0
            };
            
            if (claviculario.id) {
                const updated = await api.updateKeyholder(claviculario.id, payload);
                return updated;
            } else {
                const created = await api.createKeyholder(payload);
                return created;
            }
        } catch (error) {
            console.error('Erro ao salvar claviculário:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao salvar claviculário');
            throw error;
        }
    }

    async getClavicularios() {
        try {
            return await api.getKeyholders();
        } catch (error) {
            console.error('Erro ao buscar claviculários:', error);
            return [];
        }
    }

    async deleteClaviculario(id) {
        try {
            return await api.deleteKeyholder(id);
        } catch (error) {
            console.error('Erro ao deletar claviculário:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Erro ao deletar claviculário');
            throw error;
        }
    }
}

// Instância global do StorageManager
const storage = new StorageManager();

// ============================================
// UTILITÁRIOS
// ============================================

// Máscaras de entrada
class InputMask {
    static applyMasks() {
        document.querySelectorAll('[data-mask]').forEach(input => {
            const maskType = input.getAttribute('data-mask');
            
            input.addEventListener('input', (e) => {
                let value = e.target.value;
                
                switch (maskType) {
                    case 'cpf':
                        value = value.replace(/\D/g, '');
                        value = value.replace(/(\d{3})(\d)/, '$1.$2');
                        value = value.replace(/(\d{3})(\d)/, '$1.$2');
                        value = value.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
                        break;
                    case 'cnpj':
                        value = value.replace(/\D/g, '');
                        value = value.replace(/(\d{2})(\d)/, '$1.$2');
                        value = value.replace(/(\d{3})(\d)/, '$1.$2');
                        value = value.replace(/(\d{3})(\d)/, '$1/$2');
                        value = value.replace(/(\d{4})(\d{1,2})$/, '$1-$2');
                        break;
                    case 'phone':
                        value = value.replace(/\D/g, '');
                        if (value.length <= 10) {
                            value = value.replace(/(\d{2})(\d)/, '($1) $2');
                            value = value.replace(/(\d{4})(\d)/, '$1-$2');
                        } else {
                            value = value.replace(/(\d{2})(\d)/, '($1) $2');
                            value = value.replace(/(\d{5})(\d)/, '$1-$2');
                        }
                        break;
                    case 'cellphone':
                        value = value.replace(/\D/g, '');
                        value = value.replace(/(\d{2})(\d)/, '($1) $2');
                        value = value.replace(/(\d{5})(\d)/, '$1-$2');
                        break;
                    case 'cep':
                        value = value.replace(/\D/g, '');
                        value = value.replace(/(\d{5})(\d)/, '$1-$2');
                        break;
                    case 'plate':
                        // Brazilian plate format: ABC1234 (3 letters + 4 numbers)
                        // or new format: ABC1D23 (3 letters + 1 number + 1 letter + 2 numbers)
                        value = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                        // Allow up to 7 characters (letters + numbers)
                        value = value.substring(0, 7);
                        break;
                }
                
                e.target.value = value;
            });
        });
    }

    static validateCPF(cpf) {
        cpf = cpf.replace(/\D/g, '');
        if (cpf.length !== 11) return false;
        
        // Validação de dígitos verificadores
        let sum = 0;
        let remainder;
        
        for (let i = 1; i <= 9; i++) {
            sum += parseInt(cpf.substring(i - 1, i)) * (11 - i);
        }
        remainder = (sum * 10) % 11;
        
        if (remainder === 10 || remainder === 11) remainder = 0;
        if (remainder !== parseInt(cpf.substring(9, 10))) return false;
        
        sum = 0;
        for (let i = 1; i <= 10; i++) {
            sum += parseInt(cpf.substring(i - 1, i)) * (12 - i);
        }
        remainder = (sum * 10) % 11;
        
        if (remainder === 10 || remainder === 11) remainder = 0;
        if (remainder !== parseInt(cpf.substring(10, 11))) return false;
        
        return true;
    }

    static validateRG(rg) {
        // RG com formato básico (aceita vários formatos)
        rg = rg.replace(/\D/g, '');
        return rg.length >= 7 && rg.length <= 12;
    }

    static validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    static validatePlaca(placa) {
        // Placa brasileira: AAA-9999 ou AAA9999
        const placaRegex = /^[A-Z]{3}-?\d{4}$|^[A-Z]{3}\d[A-Z]\d{2}$/;
        return placaRegex.test(placa.toUpperCase().trim());
    }

    static validateCNPJ(cnpj) {
        cnpj = cnpj.replace(/\D/g, '');
        if (cnpj.length !== 14) return false;
        
        // Validação de dígitos verificadores
        let size = cnpj.length - 2;
        let numbers = cnpj.substring(0, size);
        let digits = cnpj.substring(size);
        let sum = 0;
        let pos = size - 7;
        
        for (let i = size; i >= 1; i--) {
            sum += numbers.charAt(size - i) * pos--;
            if (pos < 2) pos = 9;
        }
        
        let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
        if (result !== parseInt(digits.charAt(0))) return false;
        
        size = size + 1;
        numbers = cnpj.substring(0, size);
        sum = 0;
        pos = size - 7;
        
        for (let i = size; i >= 1; i--) {
            sum += numbers.charAt(size - i) * pos--;
            if (pos < 2) pos = 9;
        }
        
        result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
        if (result !== parseInt(digits.charAt(1))) return false;
        
        return true;
    }
}

// Sistema de notificações
class NotificationSystem {
    static showToast(type, title, message, duration = 5000) {
        let container = document.getElementById('toast-container');
        
        // Create container if it doesn't exist
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };
        
        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || '•'}</div>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">×</button>
        `;
        
        container.appendChild(toast);
        
        // Remover toast automaticamente após a duração
        setTimeout(() => {
            if (toast.parentElement) {
                toast.remove();
            }
        }, duration);
        
        return toast;
    }

    static showConfirm(title, message, onConfirm) {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('modal-title');
        const messageEl = document.getElementById('modal-message');
        const confirmBtn = document.getElementById('modal-confirm-btn');
        
        // Se os elementos do modal não existem, criar um modal dinâmico
        if (!modal || !titleEl || !messageEl || !confirmBtn) {
            // Criar modal inline como fallback
            const overlay = document.createElement('div');
            overlay.className = 'confirm-modal-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:999999;opacity:1;visibility:visible;pointer-events:all;margin:0;padding:0;';
            
            const modalDiv = document.createElement('div');
            modalDiv.style.cssText = 'background:white;padding:24px;border-radius:8px;max-width:400px;width:90%;';
            modalDiv.innerHTML = `
                <h3 style="margin-top:0;color:#333;">${title}</h3>
                <p style="color:#666;margin:16px 0;">${message}</p>
                <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:24px;">
                    <button id="modal-cancel-btn" style="padding:8px 16px;border:1px solid #ddd;background:#f5f5f5;border-radius:4px;cursor:pointer;">Cancelar</button>
                    <button id="modal-ok-btn" style="padding:8px 16px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;">Confirmar</button>
                </div>
            `;
            
            overlay.appendChild(modalDiv);
            document.body.appendChild(overlay);
            
            document.getElementById('modal-cancel-btn').onclick = () => overlay.remove();
            document.getElementById('modal-ok-btn').onclick = () => {
                if (typeof onConfirm === 'function') onConfirm();
                overlay.remove();
            };
            // Permitir fechar clicando no overlay
            overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
            return;
        }
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        
        modal.classList.remove('hidden');
        
        // Configurar evento de confirmação
        const confirmHandler = () => {
            onConfirm();
            modal.classList.add('hidden');
            confirmBtn.removeEventListener('click', confirmHandler);
        };
        
        confirmBtn.addEventListener('click', confirmHandler);
    }
}

// Utilitários de formatação
class Formatter {
    static formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    }

    static formatDateTime(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    static formatPhone(phone) {
        const cleaned = phone.replace(/\D/g, '');
        if (cleaned.length === 11) {
            return cleaned.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
        } else if (cleaned.length === 10) {
            return cleaned.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
        }
        return phone;
    }

    static formatCPF(cpf) {
        if (!cpf) return '';
        return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }

    static formatCNPJ(cnpj) {
        if (!cnpj) return '';
        return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
}

// ============================================
// GERENCIAMENTO DE UI
// ============================================

class UIManager {
    // Navegação entre seções
    static showSection(sectionId) {
        // Esconder todas as seções
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.remove('active');
        });
        
        // Remover active de todos os itens de menu (menu-item e submenu-item)
        document.querySelectorAll('.menu-item, .submenu-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Mostrar seção selecionada
        const section = document.getElementById(sectionId);
        if (section) {
            section.classList.add('active');
            STATE.currentSection = sectionId;
            
            // Scroll para o topo do content-area
            const contentArea = document.getElementById('contentArea');
            if (contentArea) {
                contentArea.scrollTop = 0;
            }
        }
        
        // Ativar item de menu correspondente (pode ser menu-item ou submenu-item)
        const menuItem = document.querySelector(`.menu-item[data-section="${sectionId}"], .submenu-item[data-section="${sectionId}"]`);
        if (menuItem) {
            menuItem.classList.add('active');
            // Se for submenu-item, também ativar o submenu pai
            const submenu = menuItem.closest('.submenu');
            if (submenu) {
                submenu.classList.add('active');
                const parentMenuItem = submenu.previousElementSibling;
                if (parentMenuItem && parentMenuItem.classList.contains('menu-item')) {
                    parentMenuItem.classList.add('active');
                }
            }
        }
        
        // Atualizar título da página
        this.updatePageTitle(sectionId);
        
        // Carregar dados da seção
        this.loadSectionData(sectionId);
    }

    static updatePageTitle(sectionId) {
        const titleMap = {
            'dashboard': 'Dashboard',
            'pessoas': storage.get('labels').pessoas,
            'visitantes': 'Visitantes',
            'grupos': storage.get('labels').grupos,
            'empresas': 'Empresas',
            'veiculos': 'Veículos',
            'configuracoes': 'Configurações',
            'relatorios': 'Relatórios'
        };
        
        const pageTitle = document.getElementById('page-title');
        const pageSubtitle = document.getElementById('page-subtitle');
        
        if (pageTitle) {
            pageTitle.textContent = titleMap[sectionId] || sectionId;
        }
        
        // Atualizar subtítulo baseado na seção
        const subtitleMap = {
            'dashboard': 'Visão geral do sistema',
            'pessoas': 'Gerencie ' + storage.get('labels').pessoas.toLowerCase(),
            'visitantes': 'Controle de entrada e saída',
            'grupos': 'Organize ' + storage.get('labels').grupos.toLowerCase(),
            'empresas': 'Cadastro de empresas parceiras',
            'veiculos': 'Gerenciamento de veículos cadastrados',
            'configuracoes': 'Personalize as configurações',
            'relatorios': 'Gerar relatórios e estatísticas'
        };
        
        if (pageSubtitle) {
            pageSubtitle.textContent = subtitleMap[sectionId] || '';
        }
    }

    static loadSectionData(sectionId) {
        // Se saindo de pessoas, limpar formulário
        if (sectionId !== 'pessoas') {
            PessoaManager.showList();
        }
        // Se saindo de visitantes, limpar formulário
        if (sectionId !== 'visitantes') {
            VisitanteManager.showList();
        }
        // Se saindo de grupos, limpar formulário
        if (sectionId !== 'grupos') {
            GrupoManager.showList();
        }
        
        switch (sectionId) {
            case 'dashboard':
                DashboardManager.load();
                break;
            case 'pessoas':
                PessoaManager.loadList();
                break;
            case 'visitantes':
                VisitanteManager.loadList();
                break;
            case 'grupos':
                GrupoManager.loadList();
                break;
            case 'empresas':
                EmpresaManager.loadList();
                break;
            case 'veiculos':
                VeiculoManager.loadList();
                break;
            case 'estacionamentos':
                EstacionamentoManager.loadList();
                break;
            case 'configuracoes':
                ConfigManager.load();
                break;
            case 'preferencias':
                ConfigManager.load();
                break;
        }
    }

    // Gerenciamento de abas em formulários
    static switchFormTab(tabName) {
        // Esconder todas as abas (suporta múltiplas classes)
        document.querySelectorAll('.tab-pane, .tab-content').forEach(pane => {
            pane.classList.remove('active');
        });
        
        // Remover active de todos os botões de aba (suporta múltiplas classes)
        document.querySelectorAll('.form-tab, .tab-btn').forEach(tab => {
            tab.classList.remove('active');
        });
        
        // Mostrar aba selecionada
        const pane = document.getElementById(tabName);
        const tabBtn = document.querySelector(`.form-tab[data-tab="${tabName}"], .tab-btn[onclick*="${tabName}"]`);
        
        if (pane) {
            pane.classList.add('active');
            STATE.currentFormTab = tabName;
        }
        
        if (tabBtn) {
            tabBtn.classList.add('active');
        }
    }

    // Modal de confirmação
    static showModal(title, message, onConfirm) {
        NotificationSystem.showConfirm(title, message, onConfirm);
    }

    static closeModal() {
        const modal = document.getElementById('confirm-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    // Toggle sidebar
    static toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const appLayout = document.getElementById('app-container');
        
        // Mobile: toggle active class
        if (window.innerWidth <= 768) {
            sidebar.classList.toggle('active');
            if (overlay) {
                overlay.classList.toggle('active');
            }
        } else {
            // Desktop: toggle collapsed
            sidebar.classList.toggle('collapsed');
            if (appLayout) {
                appLayout.classList.toggle('sidebar-collapsed');
            }
            
            // Salvar estado da sidebar
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebar_collapsed', isCollapsed);
        }
    }

    // Inicializar estado da sidebar
    static initSidebarState() {
        // Só aplicar estado collapsed em desktop
        if (window.innerWidth > 768) {
            const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
            const sidebar = document.getElementById('sidebar');
            const appLayout = document.getElementById('app-container');
            
            if (isCollapsed) {
                sidebar.classList.add('collapsed');
                if (appLayout) {
                    appLayout.classList.add('sidebar-collapsed');
                }
            }
        }
    }

    // Atualizar badges
    static updateBadges() {
        const stats = storage.getStats();
        
        const badgeMap = {
            'badge-pessoas': stats.pessoas,
            'badge-visitantes': stats.visitantes,
            'badge-grupos': stats.grupos,
            'badge-empresas': stats.empresas
        };
        
        Object.entries(badgeMap).forEach(([id, count]) => {
            const badge = document.getElementById(id);
            if (badge) {
                badge.textContent = count;
                badge.style.display = count > 0 ? 'flex' : 'none';
            }
        });
    }
}

// ============================================
// GERENCIADOR DE PESSOAS
// ============================================

class PessoaManager {
    static currentPage = 1;
    static totalPages = 1;
    static limit = 20;
    static total = 0;
    static allPessoas = []; // Armazena todas as pessoas para filtragem local
    static filteredPessoas = []; // Armazena pessoas filtradas
    static searchTerm = '';
    static grupoFilter = '';
    static statusFilter = '';
    static allEmpresas = []; // Armazena todas as empresas para busca por nome
    static currentPage = 1;
    static limit = 50; // Limite por página - otmizado para performance
    static totalRecords = 0;
    static totalPages = 1;
    static filteredPessoas = [];
    static searchTerm = '';
    
    static async loadList() {
        try {
            // Usar paginação do backend para melhor performance
            const page = this.currentPage || 1;
            const limit = this.limit || 50;
            const offset = (page - 1) * limit;
            
            // Ler filtros atuais
            this.statusFilter = document.getElementById('filter-status')?.value || '';
            this.grupoFilter = document.getElementById('filter-grupo')?.value || '';
            this.searchTerm = document.getElementById('search-pessoas')?.value.toLowerCase() || '';
            
            console.log('[DEBUG loadList] page:', page, 'limit:', limit);
            
            // Construir URL com filtros e paginação
            let url = `/persons?page=${page}&limit=${limit}`;
            
            // Adicionar filtro de status
            if (this.statusFilter) {
                // Converter valores do filtro para o formato esperado pelo backend
                const statusValue = this.statusFilter === 'ativo' ? 'active' : 
                                   this.statusFilter === 'inativo' ? 'inactive' : 
                                   this.statusFilter;
                url += `&status=${statusValue}`;
            }
            
            // Adicionar filtro de grupo
            if (this.grupoFilter) {
                url += `&group_id=${this.grupoFilter}`;
            }
            
            // Adicionar termo de busca
            if (this.searchTerm) {
                url += `&search=${encodeURIComponent(this.searchTerm)}`;
            }
            
            // Buscar página atual do backend
            const response = await api.request(url);
            
            console.log('[DEBUG loadList] Response:', JSON.stringify(response).substring(0, 500));
            
            if (response.success) {
                this.filteredPessoas = response.data || [];
                this.totalRecords = response.pagination?.total || 0;
                this.totalPages = response.pagination?.totalPages || 1;
                console.log('[DEBUG loadList] totalRecords:', this.totalRecords, 'totalPages:', this.totalPages);
            } else {
                this.filteredPessoas = [];
                this.totalRecords = 0;
                this.totalPages = 1;
                console.log('[DEBUG loadList] Response not successful');
            }
            
            this.allPessoas = this.filteredPessoas; // Para compatibilidade
            
            // Pré-carregar empresas para busca por nome da empresa
            // Carregar TODAS as empresas (ativas e inativas) para buscar corretamente
            if (!this.allEmpresas || this.allEmpresas.length === 0) {
                const response = await api.request('/companies?limit=10000');
                this.allEmpresas = response.success ? response.data : [];
                console.log('[DEBUG loadList] Empresas carregadas:', this.allEmpresas.length);
            }
            
            // Aplicar filtros localmente (se necessário)
            this.applyLocalFilter();
            
            const tableBody = document.getElementById('pessoas-table-body');
            const countElement = document.getElementById('pessoas-count');
            
            if (!tableBody) return;
            
            const pessoas = this.filteredPessoas;
            
            if (pessoas.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center">
                        <div class="no-data">
                            <i class="fas fa-users"></i>
                            <p>Nenhuma pessoa cadastrada</p>
                            <button class="btn btn-primary" onclick="showPessoaForm()">
                                Cadastrar primeira pessoa
                            </button>
                        </div>
                    </td>
                </tr>
            `;
            if (countElement) countElement.textContent = '0';
            this.updatePaginationControls();
            return;
        }
        
        // Pré-carregar grupos para evitar chamadas assíncronas dentro do loop
        // Empresas já foram carregadas em this.allEmpresas antes do filtro
        const gruposResponse = await storage.getGrupos();
        const gruposList = gruposResponse?.data || (Array.isArray(gruposResponse) ? gruposResponse : []);
        const gruposMap = new Map((gruposList || []).map(g => [g.id, g]));
        
        // Criar mapa de empresas com múltiplas chaves para busca
        const empresasMap = new Map();
        if (this.allEmpresas) {
            this.allEmpresas.forEach(empresa => {
                empresasMap.set(empresa.id, empresa);
                empresasMap.set(String(empresa.id), empresa);
                empresasMap.set(parseInt(empresa.id), empresa);
            });
        }

        let html = '';
        pessoas.forEach(pessoa => {
            const grupo = pessoa.group_id || pessoa.grupoId || pessoa.groupId ? (gruposMap.get(parseInt(pessoa.group_id || pessoa.grupoId || pessoa.groupId)) || gruposMap.get(pessoa.group_id || pessoa.grupoId || pessoa.groupId)) : null;
            
            // Buscar empresa - garantir que a busca funcione independente do tipo (string ou number)
            const companyIdValue = pessoa.company_id || pessoa.empresaId || pessoa.companyId;
            let empresa = null;
            if (companyIdValue) {
                const companyIdNum = parseInt(companyIdValue);
                empresa = empresasMap.get(companyIdNum) || empresasMap.get(companyIdValue) || empresasMap.get(String(companyIdNum));
            }
            
            console.log('[DEBUG] pessoa', pessoa.id, 'companyIdValue:', companyIdValue, 'empresa:', empresa);

            const displayName = pessoa.nome || pessoa.name || pessoa.full_name || '';
            const displayEmail = pessoa.email || pessoa.contact_email || 'Sem e-mail';
            const photoUrl = resolvePersonPhotoSrc(pessoa);
            const registration = pessoa.registration_number || pessoa.registrationNumber || pessoa.matricula || 'N/A';
            const isActive = (pessoa.status === 'active' || pessoa.status === 'ativo' || !pessoa.status);
            
            // Gerar botões de ação baseados no status
            let actionButtons = '';
            if (isActive) {
                // Pessoa ativa: mostrar botão para inativar
                actionButtons = `
                    <button class="btn btn-sm btn-edit" onclick="PessoaManager.edit(${pessoa.id})">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-warning" onclick="PessoaManager.inactivate(${pessoa.id})" title="Inativar">
                        <i class="fas fa-ban"></i>
                    </button>
                `;
            } else {
                // Pessoa inativa: mostrar botão para ativar e excluir permanentemente
                actionButtons = `
                    <button class="btn btn-sm btn-success" onclick="PessoaManager.activate(${pessoa.id})" title="Ativar">
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="PessoaManager.forceDelete(${pessoa.id})" title="Excluir Permanentemente">
                        <i class="fas fa-trash"></i>
                    </button>
                `;
            }

            const safePhotoUrl = photoUrl ? photoUrl.replace(/'/g, "\\'") : '';
            const safeDisplayName = (displayName || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            html += `
                <tr>
                    <td>
                        ${photoUrl ?
                            `<img src="${photoUrl}" alt="${displayName}" class="user-avatar-small foto-clicavel" onclick="openFotoViewer('${safePhotoUrl}', '${safeDisplayName}')" title="Clique para ampliar">` :
                            `<div class="user-avatar-placeholder"><i class="fas fa-user"></i></div>`
                        }
                    </td>
                    <td>
                        <div class="user-info-cell">
                            <strong class="nome-clicavel" onclick="PessoaManager.edit(${pessoa.id})" title="Clique para abrir o cadastro">${displayName}</strong>
                            <small>${displayEmail}</small>
                        </div>
                    </td>
                    <td>${registration}</td>
                    <td>${empresa ? (empresa.name || empresa.nome || empresa.corporate_name || empresa.trading_name || 'Empresa ' + empresa.id) : 'Sem empresa'}</td>
                    <td>
                        <span class="status-badge ${isActive ? 'ativo' : 'inativo'}">
                            ${isActive ? 'Ativo' : 'Inativo'}
                        </span>
                    </td>
                    <td>
                        <div class="action-buttons">
                            ${actionButtons}
                        </div>
                    </td>
                </tr>
            `;
            });
            
            tableBody.innerHTML = html;
            if (countElement) countElement.textContent = this.totalRecords;
            
            // Atualizar controles de paginação
            this.updatePaginationControls();
            
            // Atualizar select de filtro de grupo
            await this.updateGrupoFilter();
        } catch (error) {
            console.error('Erro ao carregar pessoas:', error);
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center">Erro ao carregar dados</td></tr>';
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível carregar as pessoas');
        }
    }
    
    // Aplicar filtro local
    static applyLocalFilter() {
        // Criar mapa de empresas para busca rápida por ID (com múltiplas chaves)
        const empresasMap = new Map();
        if (this.allEmpresas) {
            this.allEmpresas.forEach(empresa => {
                empresasMap.set(empresa.id, empresa);
                empresasMap.set(String(empresa.id), empresa);
                empresasMap.set(parseInt(empresa.id), empresa);
            });
        }
        
        this.filteredPessoas = this.allPessoas.filter(pessoa => {
            const nameValue = (pessoa.nome || pessoa.name || pessoa.full_name || '').toLowerCase();
            const matriculaValue = (pessoa.matricula || pessoa.registration_number || pessoa.registrationNumber || '').toLowerCase();
            
            // Buscar nome da empresa vinculada à pessoa
            const companyId = pessoa.company_id || pessoa.empresaId || pessoa.companyId;
            const empresa = companyId ? empresasMap.get(parseInt(companyId)) || empresasMap.get(companyId) || empresasMap.get(String(companyId)) : null;
            const empresaNome = empresa ? (empresa.corporate_name || empresa.razaoSocial || empresa.trading_name || empresa.nomeFantasia || '').toLowerCase() : '';
            
            const matchesSearch = !this.searchTerm || 
                nameValue.includes(this.searchTerm) || 
                matriculaValue.includes(this.searchTerm) ||
                empresaNome.includes(this.searchTerm) ||
                (companyId && String(companyId).includes(this.searchTerm));
            
            // Support both single group_id and multiple groups
            let matchesGrupo = !this.grupoFilter;
            if (this.grupoFilter) {
                const grupoIdInt = parseInt(this.grupoFilter);
                const pessoaGrupoId = pessoa.group_id || pessoa.grupoId || pessoa.groupId;
                const pessoaGrupos = pessoa.groups || pessoa.group_ids || pessoa.groupIds || [];
                
                matchesGrupo = pessoaGrupoId === grupoIdInt || pessoaGrupoId === this.grupoFilter ||
                               pessoaGrupos.some(g => (g.id || g) === grupoIdInt || (g.id || g) == this.grupoFilter);
            }
            
            const pessoaStatus = pessoa.status || '';
            const matchesStatus = !this.statusFilter || pessoaStatus === this.statusFilter || (this.statusFilter === 'ativo' && pessoaStatus === 'active') || (this.statusFilter === 'inactive' && pessoaStatus === 'inactive');

            return matchesSearch && matchesGrupo && matchesStatus;
        });
        
        // Todos os filtros (search, grupo, status) são enviados ao backend.
        // Não recalcular totalPages localmente — manter sempre o valor do backend.
        this.total = this.filteredPessoas.length;
    }
    
    // Atualizar controles de paginação
    static updatePaginationControls() {
        const prevBtn = document.getElementById('pessoas-prev-btn');
        const nextBtn = document.getElementById('pessoas-next-btn');
        const pageInfo = document.getElementById('pessoas-page-info');
        
        console.log('[DEBUG updatePaginationControls] currentPage:', this.currentPage, 'totalPages:', this.totalPages, 'totalRecords:', this.totalRecords);
        
        if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;
        if (pageInfo) pageInfo.textContent = `Página ${this.currentPage} de ${this.totalPages}`;
    }
    
    // Ir para próxima página
    static nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
            this.loadList();
        }
    }
    
    // Voltar para página anterior
    static prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.loadList();
        }
    }
    
    // Resetar para primeira página
    static resetPagination() {
        this.currentPage = 1;
    }

    static async updateGrupoFilter() {
        const select = document.getElementById('filter-grupo');
        if (!select) return;

        // Se já tem opções (além da padrão), não recarregar para não perder seleção
        if (select.options.length > 1) return;

        try {
            const response = await storage.getGrupos();
            const grupos = response?.data || (Array.isArray(response) ? response : []);
            const currentValue = select.value;
            let options = '<option value="">Todos os grupos</option>';
            grupos.forEach(grupo => {
                const id = grupo.id;
                const nome = grupo.name || grupo.nome || 'Grupos';
                options += `<option value="${id}">${nome}</option>`;
            });
            select.innerHTML = options;
            // Restaurar seleção anterior
            if (currentValue) select.value = currentValue;
        } catch (error) {
            console.error('Erro ao atualizar filtro de grupos:', error);
        }
    }

    static async filter() {
        // Resetar para primeira página ao filtrar
        this.resetPagination();
        this.searchTerm = document.getElementById('search-pessoas')?.value.toLowerCase() || '';
        this.grupoFilter = document.getElementById('filter-grupo')?.value || '';
        this.statusFilter = document.getElementById('filter-status')?.value || '';
        
        // Garantir que as empresas estão carregadas antes de filtrar
        if (!this.allEmpresas || this.allEmpresas.length === 0) {
            const response = await api.request('/companies?limit=10000');
            this.allEmpresas = response.success ? response.data : [];
        }
        
        // Aplicar filtro local e recarregar lista
        this.applyLocalFilter();
        await this.loadList();
    }
    
    // Inativar pessoa (soft delete)
    static async inactivate(id) {
        if (!confirm('Tem certeza que deseja inativar esta pessoa? Ela não aparecerá mais na lista de pessoas ativas.')) {
            return;
        }
        
        try {
            const response = await api.request(`/persons/${id}`, {
                method: 'DELETE'
            });
            
            if (response.success) {
                NotificationSystem.showToast('success', 'Pessoa Inativada', 'Pessoa inativada com sucesso.');
                this.loadList(); // Recarregar a lista
            } else {
                throw new Error(response.message || 'Erro ao inativar pessoa');
            }
        } catch (error) {
            console.error('Erro ao inativar pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível inativar a pessoa.');
        }
    }
    
    // Ativar pessoa
    static async activate(id) {
        if (!confirm('Tem certeza que deseja ativar esta pessoa? Ela voltará a aparecer na lista de pessoas ativas.')) {
            return;
        }
        
        try {
            const response = await api.request(`/persons/${id}/activate`, {
                method: 'POST'
            });
            
            if (response.success) {
                NotificationSystem.showToast('success', 'Pessoa Ativada', 'Pessoa ativada com sucesso.');
                this.loadList(); // Recarregar a lista
            } else {
                throw new Error(response.message || 'Erro ao ativar pessoa');
            }
        } catch (error) {
            console.error('Erro ao ativar pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível ativar a pessoa.');
        }
    }
    
    // Exclusão permanente de pessoa
    static async forceDelete(id) {
        if (!confirm('TEM CERTEZA? Esta ação é IRREVERSÍVEL. A pessoa será excluída permanentemente do sistema.')) {
            return;
        }
        
        if (!confirm('Confirme novamente a exclusão permanente. Esta ação não pode ser desfeita.')) {
            return;
        }
        
        try {
            const response = await api.request(`/persons/${id}/force`, {
                method: 'DELETE'
            });
            
            if (response.success) {
                NotificationSystem.showToast('success', 'Pessoa Excluída', 'Pessoa excluída permanentemente.');
                this.loadList(); // Recarregar a lista
            } else {
                throw new Error(response.message || 'Erro ao excluir pessoa');
            }
        } catch (error) {
            console.error('Erro ao excluir pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível excluir a pessoa.');
        }
    }

    static async showForm(id = null) {
        // Verificar se elementos existem antes de manipulá-los
        const pessoasList = document.getElementById('pessoas-list');
        const pessoasForm = document.getElementById('pessoas-form');
        
        if (!pessoasList || !pessoasForm) {
            console.warn('Elementos do formulário de pessoas não encontrados ainda');
            return;
        }
        
        // Alternar entre lista e formulário
        pessoasList.classList.add('hidden');
        pessoasForm.classList.remove('hidden');
        
        // Ocultar section-header quando formulário está aberto
        const sectionHeader = document.querySelector('#pessoas-list .section-header');
        if (sectionHeader) {
            sectionHeader.style.display = 'none';
        }
        
        // Limpar ou carregar dados do formulário
        this.clearForm();
        
        if (id) {
            STATE.editMode = true;
            STATE.currentEditId = id;
        } else {
            STATE.editMode = false;
            STATE.currentEditId = null;
            this.generateMatricula();
        }
        
        // Carregar selects (buscar do backend) antes de popular o formulário
        await this.loadGrupoSelect();
        await this.loadEmpresaSelect();
        this.loadEstadoSelect();

        // Agora carregar dados do formulário (se em modo edição)
        if (id) {
            await this.loadFormData(id);
        }

        // Inicializar Choices para o select de grupos após seleção
        // IMPORTANTE: Fazer isso APÓS loadFormData para que os grupos corretos estejam selecionados
        this.initializeGroupChoices();

        // Voltar para primeira aba
        UIManager.switchFormTab('dados-principais-tab');

        // Garantir que o container de abas do formulário esteja visível
        const tabContent = document.querySelector('#pessoas-form .tab-content');
        if (tabContent) tabContent.classList.add('active');
    }

    static initializeGroupChoices() {
        try { 
            if (window.Choices) {
                // Destroy previous instance if exists
                if (window.groupChoices) {
                    window.groupChoices.destroy();
                    window.groupChoices = null;
                }
                const grupoSelect = document.getElementById('pessoa-grupo');
                
                // Garantir que todas as opções tenham o atributo text correto
                Array.from(grupoSelect.options).forEach(opt => {
                    if (!opt.text || opt.text === '') {
                        const dataName = opt.getAttribute('data-name');
                        if (dataName) {
                            opt.text = dataName;
                        }
                    }
                });
                
                // Initialize Choices com renderização customizada
                const choicesConfig = { 
                    removeItemButton: true, 
                    searchEnabled: true, 
                    itemSelectText: '', 
                    shouldSort: false, 
                    placeholderValue: 'Selecione ou pesquise grupos',
                    silent: true,
                    renderChoiceLimit: -1
                };
                
                window.groupChoices = new Choices(grupoSelect, choicesConfig);
                
                // Após inicialização, sincronizar valores selecionados
                const selectedOptions = Array.from(grupoSelect.selectedOptions);
                if (selectedOptions.length > 0) {
                    selectedOptions.forEach(opt => {
                        const value = opt.value;
                        window.groupChoices.setChoiceByValue(value);
                    });
                }
            } 
        } catch(e) {
            console.warn('Choices.js initialization failed:', e);
        }
    }

    static showList() {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const pessoasList = document.getElementById('pessoas-list');
        const pessoasForm = document.getElementById('pessoas-form');
        
        if (!pessoasList || !pessoasForm) return;
        
        // Limpar formulário ao fechar
        this.clearForm();
        
        pessoasList.classList.remove('hidden');
        pessoasForm.classList.add('hidden');
        
        // Mostrar section-header quando voltamos à lista
        const sectionHeader = document.querySelector('#pessoas-list .section-header');
        if (sectionHeader) {
            sectionHeader.style.display = 'flex';
        }
        
        this.loadList();
        // Remover classe active do container de abas do formulário para escondê-lo
        const tabContent = document.querySelector('#pessoas-form .tab-content');
        if (tabContent) tabContent.classList.remove('active');
    }

    static clearForm() {
        const form = document.getElementById('form-pessoa');
        if (form) {
            form.reset();
        }
        
        // Limpar cache da foto
        STATE.personPhoto = null;
        STATE.personPhotoChanged = false;
        
        // Limpar preview da foto
        const preview = document.getElementById('photo-preview');
        if (preview) {
            preview.innerHTML = `
                <div class="photo-circle-placeholder">
                    <i class="fas fa-camera"></i>
                    <span>Adicionar foto</span>
                </div>
            `;
            preview.classList.remove('has-image');
            preview.style.backgroundImage = '';
        }
        
        // Limpar campos de veículo
        document.getElementById('veiculo-placa').value = '';
        document.getElementById('veiculo-marca').value = '';
        document.getElementById('veiculo-modelo').value = '';
        document.getElementById('veiculo-cor').value = '';
        
        // Limpar tabela de veículos
        const veiculosTableBody = document.getElementById('veiculos-table-body');
        if (veiculosTableBody) {
            veiculosTableBody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Nenhum veículo adicionado</td></tr>';
        }
    }

    static async loadFormData(id) {
        const pessoa = await storage.getPessoa(id);
        console.log('[DEBUG] loadFormData - pessoa from storage:', pessoa);
        if (!pessoa) return;

        // Normalizar possíveis chaves (pt-BR, en snake_case, camelCase)
        const name = pessoa.nome || pessoa.name || pessoa.full_name || '';
        const registration = pessoa.matricula || pessoa.registration_number || pessoa.registrationNumber || '';
        const birthDate = pessoa.dataNascimento || pessoa.birth_date || pessoa.birthDate || '';
        const gender = pessoa.genero || pessoa.gender || '';
        // Map backend gender codes (M/F/O/NI) back to frontend option values
        let mappedGender = '';
        if (typeof gender === 'string') {
            const g = gender.toUpperCase();
            switch (g) {
                case 'M': mappedGender = 'masculino'; break;
                case 'F': mappedGender = 'feminino'; break;
                case 'O': mappedGender = 'outro'; break;
                case 'NI': mappedGender = 'nao_informar'; break;
                default: mappedGender = (gender || '').toString();
            }
        }
        const groupId = pessoa.grupoId || pessoa.group_id || pessoa.groupId || '';
        const companyId = pessoa.empresaId || pessoa.company_id || pessoa.companyId || '';

        // Preencher campos básicos
        document.getElementById('pessoa-id').value = pessoa.id;
        document.getElementById('pessoa-nome').value = name;
        document.getElementById('pessoa-matricula').value = registration;
        document.getElementById('pessoa-cpf').value = pessoa.cpf || '';
        document.getElementById('pessoa-rg').value = pessoa.rg || '';
        document.getElementById('pessoa-data-nascimento').value = birthDate;
        document.getElementById('pessoa-genero').value = mappedGender;
        // Support multiple selected groups
        const grupoSelect = document.getElementById('pessoa-grupo');
        if (grupoSelect) {
            // Ensure options exist already (loadGrupoSelect should be called before)
            try {
                // Backend returns groups as array of objects with id and name
                const groupsArray = pessoa.groups || [];
                let ids = [];
                
                // Extract IDs from groups array
                if (Array.isArray(groupsArray) && groupsArray.length > 0) {
                    ids = groupsArray.map(g => String(g.id || g));
                } else {
                    // Fallback to single group_id field
                    const rawGroupId = pessoa.group_id || pessoa.groupId || '';
                    if (rawGroupId) {
                        ids = [String(rawGroupId)];
                    }
                }

                // Select matching options (native select)
                if (ids.length > 0) {
                    Array.from(grupoSelect.options).forEach(opt => {
                        opt.selected = ids.includes(opt.value) || ids.includes(String(opt.value));
                    });
                }
            } catch (e) {
                console.warn('Erro ao selecionar grupos:', e);
            }
        }
        // Set company in combobox
        if (companyId && window.pessoaEmpresasList) {
            let empresa = window.pessoaEmpresasList.find(e => String(e.id) === String(companyId));
            
            // Fallback: if not found by ID, try to find by name
            if (!empresa && companyId && typeof companyId === 'string') {
                empresa = window.pessoaEmpresasList.find(e => e.name.toLowerCase().includes(companyId.toLowerCase()));
            }
            
            // If still not found, check if company_id is a number in string format
            if (!empresa && companyId) {
                const numId = parseInt(companyId, 10);
                if (!isNaN(numId)) {
                    empresa = window.pessoaEmpresasList.find(e => e.id === numId);
                }
            }
            
            if (empresa) {
                selectPessoaEmpresaOption(empresa.id, empresa.name);
            } else if (companyId && typeof companyId === 'string' && companyId.length > 0) {
                // If company ID was not found in list but has a value, show it as manual entry
                selectPessoaEmpresaOption('', companyId);
            }
        }

        // Dados adicionais
        document.getElementById('pessoa-nome-pai').value = pessoa.nomePai || pessoa.father_name || '';
        document.getElementById('pessoa-nome-mae').value = pessoa.nomeMae || pessoa.mother_name || '';
        document.getElementById('pessoa-estado-civil').value = pessoa.estadoCivil || pessoa.marital_status || '';
        document.getElementById('pessoa-nacionalidade').value = pessoa.nacionalidade || pessoa.nationality || '';
        document.getElementById('pessoa-naturalidade').value = pessoa.naturalidade || pessoa.naturality || '';

        // Profissional
        document.getElementById('pessoa-profissao').value = pessoa.profissao || pessoa.profession || '';
        document.getElementById('pessoa-cargo').value = pessoa.cargo || pessoa.position || '';
        document.getElementById('pessoa-data-admissao').value = pessoa.dataAdmissao || pessoa.admission_date || '';
        document.getElementById('pessoa-telefone').value = pessoa.telefone || pessoa.phone || '';
        document.getElementById('pessoa-celular').value = pessoa.celular || pessoa.cellphone || '';
        
        // Carregar DDI do celular (com debug)
        const ddiSelect = document.getElementById('pessoa-celular-ddi');
        console.log('[DEBUG] loadFormData - Dados recebidos:', JSON.stringify(pessoa));
        console.log('[DEBUG] loadFormData - cellphone_ddi:', pessoa.cellphone_ddi);
        console.log('[DEBUG] loadFormData - Elemento DDI encontrado:', !!ddiSelect);
        if (ddiSelect) {
            const savedDdi = pessoa.cellphone_ddi || '+55';
            console.log('[DEBUG] Carregando DDI do celular:', savedDdi);
            ddiSelect.value = savedDdi;
            console.log('[DEBUG] Valor definido no select:', ddiSelect.value);
        }
        document.getElementById('pessoa-email').value = pessoa.email || '';
        document.getElementById('pessoa-ramal').value = pessoa.ramal || pessoa.extension || '';

        // Endereço
        document.getElementById('pessoa-cep').value = pessoa.cep || '';
        document.getElementById('pessoa-endereco').value = pessoa.endereco || pessoa.address || '';
        document.getElementById('pessoa-numero').value = pessoa.numero || pessoa.street_number || '';
        document.getElementById('pessoa-complemento').value = pessoa.complemento || pessoa.address_complement || '';
        document.getElementById('pessoa-bairro').value = pessoa.bairro || pessoa.neighborhood || '';
        document.getElementById('pessoa-cidade').value = pessoa.cidade || pessoa.city || '';
        document.getElementById('pessoa-estado').value = pessoa.estado || pessoa.state || '';

        // Mobile Permissions
        const mobilePerms = pessoa.mobile_permissions || ['equipments', 'packages', 'monitoring'];
        document.getElementById('perm-mobile-equipments').checked = mobilePerms.includes('equipments');
        document.getElementById('perm-mobile-packages').checked = mobilePerms.includes('packages');
        document.getElementById('perm-mobile-monitoring').checked = mobilePerms.includes('monitoring');
        document.getElementById('perm-mobile-visitors').checked = mobilePerms.includes('visitors');
        document.getElementById('perm-mobile-vehicles').checked = mobilePerms.includes('vehicles');
        document.getElementById('pessoa-mobile-password').value = ''; // Always clear password field on load

        // Veículos (backend pode retornar 'vehicle' ou 'vehicles' como array)
        const vehicles = pessoa.vehicles || (pessoa.vehicle ? [pessoa.vehicle] : []);
        console.log('[DEBUG] Vehicles from backend:', vehicles);
        console.log('[DEBUG] Pessoa data:', pessoa);
        
        // Limpar a tabela de veículos antes de adicionar
        const veiculosTableBody = document.getElementById('veiculos-table-body');
        if (veiculosTableBody) {
            veiculosTableBody.innerHTML = '<tr><td colspan="7" class="text-center">Nenhum veículo cadastrado</td></tr>';
        }
        
        if (vehicles && vehicles.length > 0) {
            for (const vehicle of vehicles) {
                console.log('[DEBUG] Vehicle data received:', vehicle);
                document.getElementById('veiculo-placa').value = vehicle.placa || vehicle.license_plate || '';
                document.getElementById('veiculo-marca').value = vehicle.marca || vehicle.brand || '';
                document.getElementById('veiculo-modelo').value = vehicle.modelo || vehicle.model || '';
                document.getElementById('veiculo-cor').value = vehicle.cor || vehicle.color || '';
                
                // Preencher campos de vaga
                const parkingId = vehicle.parking_id || vehicle.parkingId || null;
                const companyId = vehicle.company_id || vehicle.companyId || null;
                const spotNumber = vehicle.spot_number || vehicle.spotNumber || null;
                const tagNumero = vehicle.tag_number || vehicle.tagNumero || '';
                
                console.log('[DEBUG] Parking ID:', parkingId);
                console.log('[DEBUG] Company ID:', companyId);
                console.log('[DEBUG] Spot Number:', spotNumber);
                console.log('[DEBUG] Tag Number:', tagNumero);
                
                // Selecionar tipo de vaga
                const tipoVagaSelect = document.getElementById('veiculo-tipo-vaga');
                console.log('[DEBUG] tipoVagaSelect element:', tipoVagaSelect);
                if (tipoVagaSelect) {
                    if (parkingId) {
                        console.log('[DEBUG] Setting tipoVaga to fixa');
                        tipoVagaSelect.value = 'fixa';
                        // Mostrar container de vaga fixa
                        const vagaContainer = document.getElementById('veiculo-vaga-container');
                        console.log('[DEBUG] vagaContainer element:', vagaContainer);
                        if (vagaContainer) vagaContainer.style.display = 'block';
                        // Carregar vagas e selecionar a correta
                        loadAvailableSpots().then(() => {
                            console.log('[DEBUG] loadAvailableSpots completed');
                            const vagaSelect = document.getElementById('veiculo-vaga');
                            console.log('[DEBUG] vagaSelect element:', vagaSelect);
                            if (vagaSelect && parkingId) {
                                console.log('[DEBUG] Setting vagaSelect value to:', parkingId);
                                vagaSelect.value = parkingId;
                            }
                        });
                    } else if (companyId) {
                        console.log('[DEBUG] Setting tipoVaga to rotativa');
                        tipoVagaSelect.value = 'rotativa';
                        // Mostrar container de vaga rotativa
                        const empresaContainer = document.getElementById('veiculo-empresa-container');
                        console.log('[DEBUG] empresaContainer element:', empresaContainer);
                        if (empresaContainer) empresaContainer.style.display = 'block';
                        // Carregar empresas e selecionar a correta
                        loadEmpresasForVagaRotativa().then(() => {
                            console.log('[DEBUG] loadEmpresasForVagaRotativa completed');
                            const empresaSelect = document.getElementById('veiculo-empresa');
                            console.log('[DEBUG] empresaSelect element:', empresaSelect);
                            if (empresaSelect && companyId) {
                                console.log('[DEBUG] Setting empresaSelect value to:', companyId);
                                empresaSelect.value = companyId;
                            }
                        });
                    } else {
                        console.log('[DEBUG] No parkingId or companyId found, cannot set vaga type');
                    }
                }
                
                // Preencher tag
                const tagInput = document.getElementById('veiculo-tag-numero');
                if (tagInput) tagInput.value = tagNumero;
                
                // Adicionar veículo à tabela para visibilidade (apenas o primeiro preenche o formulário)
                addVeiculoToTableFromEdit(vehicle);
            }
        } else {
            console.log('[DEBUG] No vehicles found in pessoa data');
        }

        // Foto: sempre priorizar photo_url (arquivo); base64 do banco é legado e pode estar desatualizado
        const photoUrl = resolvePersonPhotoSrc(pessoa);
        
        if (photoUrl) {
            const preview = document.getElementById('photo-preview');
            if (preview) {
                const displaySrc = photoUrl;
                preview.innerHTML = `<img src="${displaySrc}" alt="${name}">`;
                preview.classList.add('has-image');
                STATE.personPhoto = null;
                STATE.personPhotoChanged = false;
            }
        }
        
        // Carregar digitais cadastradas (biometria)
        if (typeof carregarDigitais === 'function') {
            carregarDigitais();
        }
    }

    static async loadGrupoSelect() {
        const select = document.getElementById('pessoa-grupo');
        if (!select) return;

        try {
            const response = await storage.getGrupos();
            const grupos = response?.data || (Array.isArray(response) ? response : []);
            let options = '<option value="">Selecione um grupo</option>';
            grupos.forEach(grupo => {
                const id = grupo.id || grupo.id;
                const nome = grupo.name || grupo.nome || grupo.title || 'Grupo';
                options += `<option value="${id}" data-name="${nome}">${nome}</option>`;
            });
            select.innerHTML = options;
            // Garantir que o select tenha um name e não bloqueie validação nativa
            try {
                select.name = select.name || 'group_ids[]';
                select.required = false;
                select.multiple = true;
            } catch (e) {}

            // Choices initialization is performed after populating form so selected items are preserved
        } catch (error) {
            console.error('Erro ao carregar select de grupos:', error);
            select.innerHTML = '<option value="">Erro ao carregar grupos</option>';
        }
    }

    static async loadEmpresaSelect() {
        const input = document.getElementById('pessoa-empresa');
        if (!input) return;

        try {
            // Carregar TODAS as empresas (ativas e inativas) usando a API com limite maior
            const response = await api.request('/companies?limit=10000');
            const empresas = response.success ? response.data : [];
            
            // Armazenar as empresas para usar no combobox
            window.pessoaEmpresasList = empresas.map(e => ({
                id: e.id,
                name: (e.corporate_name || e.razaoSocial || e.trading_name || e.nomeFantasia || 'Empresa') + (e.active === false ? ' (Inativa)' : '')
            }));
            
            console.log('Empresas carregadas para combobox:', window.pessoaEmpresasList.length);
            
            // Inicializar o combobox
            initPessoaEmpresaCombobox();
        } catch (error) {
            console.error('Erro ao carregar combobox de empresas:', error);
        }
    }

    static loadEstadoSelect() {
        const select = document.getElementById('pessoa-estado');
        if (!select) return;
        
        const estados = [
            'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 
            'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 
            'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
        ];
        
        let options = '<option value="">Selecione</option>';
        estados.forEach(estado => {
            options += `<option value="${estado}">${estado}</option>`;
        });
        
        select.innerHTML = options;
    }

    static async generateMatricula() {
        try {
            const response = await api.request('/persons/generate-registration');
            if (response && response.success && response.data) {
                const input = document.getElementById('pessoa-matricula');
                if (input) {
                    input.value = response.data;
                }
            } else {
                throw new Error('Falha ao gerar matrícula');
            }
        } catch (error) {
            console.error('Erro ao gerar matrícula:', error);
            alert('Erro ao gerar matrícula no servidor');
            
            // Fallback para o método antigo em caso de erro crítico no servidor
            const fallback = storage.generateMatricula();
            const input = document.getElementById('pessoa-matricula');
            if (input) input.value = fallback;
        }
    }

    static async checkDuplicates(pessoa) {
        // Validações de duplicação (excetuando registro atual em modo edição)
        const todasAsPessoas = await storage.getPessoas() || [];
        // Usar STATE.currentEditId para garantir que estamos ignorando o registro atual
        const currentId = STATE.currentEditId || (pessoa.id || null);
        const pessoasOutras = todasAsPessoas.filter(p => p.id !== currentId);
        
        const errors = [];
        
        // Validar CPF (se preenchido)
        if (pessoa.cpf) {
            const cpfDuplicado = pessoasOutras.some(p => 
                (p.cpf || '').replace(/\D/g, '') === pessoa.cpf.replace(/\D/g, '')
            );
            if (cpfDuplicado) {
                errors.push('CPF já cadastrado no sistema');
            }
        }
        
        // Validar RG (se preenchido)
        if (pessoa.rg) {
            const rgDuplicado = pessoasOutras.some(p => 
                (p.rg || '').replace(/\D/g, '') === pessoa.rg.replace(/\D/g, '')
            );
            if (rgDuplicado) {
                errors.push('RG já cadastrado no sistema');
            }
        }
        
        // Validar Email (se preenchido)
        if (pessoa.email) {
            const emailDuplicado = pessoasOutras.some(p => 
                (p.email || '').toLowerCase() === pessoa.email.toLowerCase()
            );
            if (emailDuplicado) {
                errors.push('Email já cadastrado no sistema');
            }
        }
        
        // Validar Nome (evitar duplicatas exatas)
        if (pessoa.nome) {
            const nomeDuplicado = pessoasOutras.some(p => 
                (p.nome || '').toLowerCase() === pessoa.nome.toLowerCase()
            );
            if (nomeDuplicado) {
                errors.push('Nome igual já está cadastrado - considere adicionar um sufixo ou mudança');
            }
        }
        
        // Validar Placa de Veículo (se preenchida)
        if (pessoa.veiculo && pessoa.veiculo.placa) {
            const placaDuplicada = pessoasOutras.some(p => {
                const veiculoOutro = p.veiculo || {};
                return (veiculoOutro.placa || '').toUpperCase() === pessoa.veiculo.placa.toUpperCase();
            });
            if (placaDuplicada) {
                errors.push('Placa de veículo já cadastrada para outra pessoa');
            }
        }
        
        return errors;
    }

    static async save(event) {
        event.preventDefault();
        
        // Validar CPF
        const cpf = document.getElementById('pessoa-cpf').value;
        if (cpf && !InputMask.validateCPF(cpf)) {
            NotificationSystem.showToast('error', 'CPF Inválido', 'Por favor, insira um CPF válido.');
            return;
        }
        
        // Validar RG
        const rg = document.getElementById('pessoa-rg').value;
        if (rg && !InputMask.validateRG(rg)) {
            NotificationSystem.showToast('error', 'RG Inválido', 'RG deve conter 7 a 12 dígitos.');
            return;
        }
        
        // Validar Email
        const email = document.getElementById('pessoa-email').value;
        if (email && !InputMask.validateEmail(email)) {
            NotificationSystem.showToast('error', 'Email Inválido', 'Por favor, insira um email válido.');
            return;
        }
        
        // Validar Placa de Veículo
        const placa = document.getElementById('veiculo-placa').value;
        if (placa && !InputMask.validatePlaca(placa)) {
            NotificationSystem.showToast('error', 'Placa Inválida', 'Placa deve ser no formato AAA-9999 ou AAA9A99.');
            return;
        }
        
        // Coletar dados do veículo da tabela ou do formulário
        const veiculosTableBody = document.getElementById('veiculos-table-body');
        let veiculosData = []; // Alterado para array
        
        console.log('[DEBUG] veiculosTableBody:', veiculosTableBody);
        console.log('[DEBUG] veiculosTableBody.innerHTML:', veiculosTableBody ? veiculosTableBody.innerHTML : 'null');
        // Se houver veículos na tabela, coletar todos
        if (veiculosTableBody && veiculosTableBody.querySelector('tr')) {
            console.log('[DEBUG] Found vehicle rows');
            const rows = veiculosTableBody.querySelectorAll('tr');
            console.log('[DEBUG] Number of rows:', rows.length);
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 1 && !cells[0].textContent.includes('Nenhum')) {
                    // Ler dados da tabela - a estrutura é: placa, marca, modelo, cor, tipoVaga, vagaInfo, tag
                    const placaTabela = cells[0].textContent.trim();
                    const marcaTabela = cells[1].textContent.trim();
                    const modeloTabela = cells[2].textContent.trim();
                    const corTabela = cells[3].textContent.trim();
                    const tipoVagaTexto = cells[4].textContent.trim();
                    const vagaInfoTexto = cells[5].textContent.trim();
                    const tagTexto = cells[6].textContent.trim();
                    
                    // Obter IDs dos atributos data na linha
                    const veiculoVagaId = row.getAttribute('data-parking-id') || row.getAttribute('data-vaga-id');
                    const veiculoEmpresaId = row.getAttribute('data-company-id') || row.getAttribute('data-empresa-id');
                    
                    // Determinar tipo de vaga pelo texto
                    const veiculoTipoVaga = tipoVagaTexto.includes('Fixa') ? 'fixa' : (tipoVagaTexto.includes('Rotativa') ? 'rotativa' : '');
                    
                    console.log('[DEBUG] veiculoTipoVaga from text:', veiculoTipoVaga);
                    
                    // Tentar obter o ID da vaga/empresa pelo fallback se não encontrou pelo data-attributos
                    let vagasFallback = null;
                    let empresasFallback = null;
                    
                    // Se tem tipo de vaga definida no texto mas não tem ID, usar fallback
                    if (veiculoTipoVaga === 'fixa' && !veiculoVagaId) {
                        const vagaSelect = document.getElementById('veiculo-vaga');
                        console.log('[DEBUG] vagaSelect:', vagaSelect);
                        if (vagaSelect) {
                            const vagaInfoClean = vagaInfoTexto.replace('🔧 ', '');
                            console.log('[DEBUG] Looking for vaga:', vagaInfoClean);
                            for (const option of vagaSelect.options) {
                                if (option.text.includes(vagaInfoClean)) {
                                    vagasFallback = option.value;
                                    console.log('[DEBUG] Found vaga fallback:', vagasFallback);
                                    break;
                                }
                            }
                        }
                    } else if (veiculoTipoVaga === 'rotativa' && !veiculoEmpresaId) {
                        const empresaSelect = document.getElementById('veiculo-empresa');
                        if (empresaSelect) {
                            const empresaInfoClean = vagaInfoTexto.replace('Rotativa - ', '');
                            for (const option of empresaSelect.options) {
                                if (option.text.includes(empresaInfoClean)) {
                                    empresasFallback = option.value;
                                    break;
                                }
                            }
                        }
                    }
                    
                    veiculosData.push({
                        placa: placaTabela,
                        marca: marcaTabela,
                        modelo: modeloTabela,
                        cor: corTabela,
                        color: corTabela, // Mapear cor para color para o backend
                        ano: null,
                        parking_id: veiculoTipoVaga === 'fixa' ? (veiculoVagaId || vagasFallback) : null,
                        company_id: veiculoTipoVaga === 'rotativa' ? (veiculoEmpresaId || empresasFallback) : null,
                        spot_number: veiculoTipoVaga === 'fixa' ? vagaInfoTexto.replace('🔧 ', '') : null,
                        tag_number: tagTexto !== '-' ? tagTexto.replace('�', '').trim() : null
                    });
                    console.log('[DEBUG] Vehicle from table - tipoVaga:', veiculoTipoVaga, 'vagaId:', veiculoVagaId, 'empresaId:', veiculoEmpresaId, 'fallback empresa:', empresasFallback);
                    console.log('[DEBUG] Row data attributes:', row.getAttribute('data-parking-id'), row.getAttribute('data-vaga-id'), row.getAttribute('data-company-id'));
                    // Removido o break para coletar todos os veículos
                }
            }
        }
        
        
        // Se não encontrou veículos na tabela, tentar do formulário
        if (veiculosData.length === 0) {
            const veiculoForm = {
                placa: placa,
                marca: document.getElementById('veiculo-marca').value,
                modelo: document.getElementById('veiculo-modelo').value,
                cor: document.getElementById('veiculo-cor').value,
                color: document.getElementById('veiculo-cor').value, // Mapear cor para color para o backend
                parking_id: null,
                company_id: null,
                spot_number: null,
                tag_number: null
            };
            if (veiculoForm.placa) {
                veiculosData.push(veiculoForm);
            }
        }
        
        console.log('[DEBUG] Vehicles data to save:', veiculosData);
        console.log('[DEBUG] Full veiculosData for API:', JSON.stringify(veiculosData));
        
        // Coletar dados do formulário
        const pessoa = {
            id: STATE.editMode ? parseInt(document.getElementById('pessoa-id').value) : null,
            nome: document.getElementById('pessoa-nome').value,
            matricula: document.getElementById('pessoa-matricula').value,
            cpf: cpf,
            rg: rg,
            dataNascimento: document.getElementById('pessoa-data-nascimento').value,
            // Map frontend gender values to backend codes: M, F, O, NI
            genero: (function(){
                const g = (document.getElementById('pessoa-genero').value || '').toString().toLowerCase();
                switch(g) {
                    case 'masculino': case 'm': case 'male': return 'M';
                    case 'feminino': case 'f': case 'female': return 'F';
                    case 'outro': case 'o': case 'other': return 'O';
                    case 'nao_informar': case 'prefiro nao informar': case 'ni': return 'NI';
                    default: return null;
                }
            })(),
            // Collect multiple selected group ids
            grupoIds: (function(){
                const sel = document.getElementById('pessoa-grupo');
                if (!sel) return null;
                const vals = Array.from(sel.selectedOptions).map(o => o.value).filter(v => v && v !== '');
                return vals.length ? vals : null;
            })(),
            empresaId: document.getElementById('pessoa-empresa-value').value || null,
            company_id: document.getElementById('pessoa-empresa-value').value || null,
            
            // Debug log
            empresaName: (function() {
                const input = document.getElementById('pessoa-empresa');
                const valueInput = document.getElementById('pessoa-empresa-value');
                console.log('[DEBUG] Empresa input value:', input ? input.value : 'N/A');
                console.log('[DEBUG] Empresa hidden value:', valueInput ? valueInput.value : 'N/A');
                return input ? input.value : '';
            })(),
            
            // Dados adicionais
            nomePai: document.getElementById('pessoa-nome-pai').value,
            nomeMae: document.getElementById('pessoa-nome-mae').value,
            estadoCivil: document.getElementById('pessoa-estado-civil').value,
            nacionalidade: document.getElementById('pessoa-nacionalidade').value,
            naturalidade: document.getElementById('pessoa-naturalidade').value,
            
            // Profissional
            profissao: document.getElementById('pessoa-profissao').value,
            cargo: document.getElementById('pessoa-cargo').value,
            dataAdmissao: document.getElementById('pessoa-data-admissao').value,
            telefone: document.getElementById('pessoa-telefone').value,
            celular: document.getElementById('pessoa-celular').value,
            cellphone_ddi: (function() {
                const ddiEl = document.getElementById('pessoa-celular-ddi');
                const ddi = ddiEl ? ddiEl.value : '+55';
                console.log('[DEBUG] Salvando DDI do celular:', ddi);
                console.log('[DEBUG] Elemento encontrado:', !!ddiEl);
                if (ddiEl) {
                    console.log('[DEBUG] Valor do elemento:', ddiEl.value);
                }
                return ddi;
            })(),
            email: email,
            ramal: document.getElementById('pessoa-ramal').value,
            
            // Endereço
            cep: document.getElementById('pessoa-cep').value,
            endereco: document.getElementById('pessoa-endereco').value,
            numero: document.getElementById('pessoa-numero').value,
            complemento: document.getElementById('pessoa-complemento').value,
            bairro: document.getElementById('pessoa-bairro').value,
            cidade: document.getElementById('pessoa-cidade').value,
            estado: document.getElementById('pessoa-estado').value,
            
            // Veículos (array para suportar múltiplos veículos)
            veiculo: veiculosData.length > 0 ? veiculosData[0] : null,
            veiculos: veiculosData,
            
            // Foto em Base64
            foto: this.getPhotoData(),
            photo_base64: this.getPhotoData(),
            
            // Status (usar inglês para compatibilidade com backend)
            status: 'active',
            
            // Mobile App Access
            mobile_password: document.getElementById('pessoa-mobile-password').value || null,
            mobile_permissions: (function() {
                const perms = [];
                if (document.getElementById('perm-mobile-equipments').checked) perms.push('equipments');
                if (document.getElementById('perm-mobile-packages').checked) perms.push('packages');
                if (document.getElementById('perm-mobile-monitoring').checked) perms.push('monitoring');
                if (document.getElementById('perm-mobile-visitors').checked) perms.push('visitors');
                if (document.getElementById('perm-mobile-vehicles').checked) perms.push('vehicles');
                return perms;
            })(),

            qrcode_type: document.getElementById('pessoa-qrcode-tipo') ? document.getElementById('pessoa-qrcode-tipo').value : null,
            qrcode_value: (typeof getPessoaQrcodeValue === 'function') ? getPessoaQrcodeValue() : null,
            cartoes: (typeof getPessoaCartoes === 'function') ? getPessoaCartoes() : [],
            dataAtualizacao: new Date().toISOString()
        };
        
        try {
            console.log('[DEBUG] Saving pessoa with vehicle:', pessoa.veiculo);
            // Verificar duplicatas
            const duplicates = await this.checkDuplicates(pessoa);
            if (duplicates.length > 0) {
                const message = duplicates.join('\n• ');
                NotificationSystem.showToast('error', 'Dados Duplicados', '• ' + message);
                return;
            }
            
            const hadNewPhoto = !!pessoa.foto;
            const savedPessoa = await storage.savePessoa(pessoa);
            STATE.personPhotoChanged = false;
            STATE.personPhoto = null;
            
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Pessoa Atualizada' : 'Pessoa Cadastrada',
                `${savedPessoa.nome || pessoa.nome} foi ${STATE.editMode ? 'atualizada' : 'cadastrada'} com sucesso!${hadNewPhoto ? ' Foto atualizada.' : ''}`
            );
            
            // Voltar para lista e atualizar dashboard
            this.showList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao salvar pessoa:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar a pessoa. Tente novamente.');
        }
    }

    static getPhotoData() {
        if (!STATE.personPhotoChanged) return null;
        const isNewPhoto = (src) => typeof src === 'string' && src.startsWith('data:image');
        if (STATE.personPhoto && isNewPhoto(STATE.personPhoto)) {
            return STATE.personPhoto;
        }
        const preview = document.getElementById('photo-preview');
        const img = preview ? preview.querySelector('img') : null;
        if (img && isNewPhoto(img.src)) {
            return img.src;
        }
        return null;
    }

    static markPersonPhotoChanged(photoData) {
        if (photoData && String(photoData).startsWith('data:image')) {
            STATE.personPhoto = photoData;
            STATE.personPhotoChanged = true;
        }
    }

    static edit(id) {
        // Tentar abrir o formulário, com retry se elementos não existirem ainda
        const tryShowForm = (retries = 5) => {
            const pessoasList = document.getElementById('pessoas-list');
            const pessoasForm = document.getElementById('pessoas-form');
            
            if (pessoasList && pessoasForm) {
                this.showForm(id);
            } else if (retries > 0) {
                // Aguardar e tentar novamente
                setTimeout(() => tryShowForm(retries - 1), 200);
            } else {
                console.warn('Não foi possível abrir formulário de pessoa após múltiplas tentativas');
            }
        };
        
        tryShowForm();
    }

    static async confirmDelete(id) {
        const pessoa = await storage.getPessoa(id);
        if (!pessoa) return;

        const displayName = pessoa.nome || pessoa.name || pessoa.registration_number || pessoa.registrationNumber || 'registro';
        UIManager.showModal(
            'Confirmar Exclusão',
            `Tem certeza que deseja excluir "${displayName}"? Esta ação não pode ser desfeita.`,
            () => this.delete(id)
        );
    }

    static delete(id) {
        storage.deletePessoa(id);
        NotificationSystem.showToast('success', 'Pessoa Excluída', 'Pessoa excluída com sucesso.');
        this.loadList();
        DashboardManager.load();
        UIManager.updateBadges();
    }

    static handlePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        // Validar tipo e tamanho do arquivo
        const validTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (!validTypes.includes(file.type)) {
            NotificationSystem.showToast('error', 'Formato Inválido', 'Apenas imagens JPG, PNG ou GIF são permitidas.');
            return;
        }
        
        if (file.size > 2 * 1024 * 1024) { // 2MB
            NotificationSystem.showToast('error', 'Arquivo Grande', 'A imagem deve ter no máximo 2MB.');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.getElementById('photo-preview');
            preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
            preview.classList.add('has-image');
            PessoaManager.markPersonPhotoChanged(e.target.result);
        };
        reader.readAsDataURL(file);
    }

    static openFilePicker() {
        document.getElementById('photo-input').click();
    }

    // Estado para controle de captura de foto
    static cameraState = 'idle'; // 'idle', 'capturing', 'preview'

    static async openCamera() {
        try {
            // Se já está no modo de captura, confirmar a foto
            if (PessoaManager.cameraState === 'capturing') {
                PessoaManager.capturePhoto();
                return;
            }
            
            // Se já tem foto capturada, substituir
            if (STATE.personPhoto) {
                // Limpar foto anterior e continuar para capturar nova
                STATE.personPhoto = null;
            }
            
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            STATE.cameraActive = true;
            STATE.cameraStream = stream;
            
            // Criar vídeo para capturar foto diretamente no círculo
            const preview = document.getElementById('photo-preview');
            if (!preview) {
                // Fallback: usar modal se o preview não existir
                this.showCameraModal(stream);
                return;
            }
            
            // Criar elemento de vídeo
            const video = document.createElement('video');
            video.id = 'photo-video-capture';
            video.autoplay = true;
            video.playsInline = true;
            video.style.cssText = 'width: 100%; height: 100%; object-fit: cover; border-radius: 50%;';
            
            // Substituir conteúdo do círculo
            preview.innerHTML = '';
            preview.appendChild(video);
            
            video.srcObject = stream;
            
            // Atualizar estado
            PessoaManager.cameraState = 'capturing';
            
            // Atualizar texto do botão Câmera para indicar que precisa confirmar
            const cameraBtn = document.querySelector('#pessoas-form .photo-btn');
            if (cameraBtn) {
                cameraBtn.innerHTML = 'Upload';
                cameraBtn.classList.remove('btn-primary');
                cameraBtn.classList.add('btn-success');
            }
            
            // Atualizar label do círculo
            const placeholder = preview.querySelector('.photo-circle-placeholder');
            if (placeholder) {
                placeholder.innerHTML = '<span>Clique em Confirmar</span>';
            }
            
            // Criar botão de fechar (X)
            const closeBtn = document.createElement('button');
            closeBtn.id = 'photo-close-cam-btn';
            closeBtn.innerHTML = '<i class="fas fa-times"></i>';
            closeBtn.style.cssText = 'position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 50%; background: rgba(0,0,0,0.5); color: white; border: none; cursor: pointer; z-index: 10;';
            closeBtn.onclick = (e) => { e.stopPropagation(); PessoaManager.closeCamera(); };
            preview.appendChild(closeBtn);
            
        } catch (error) {
            NotificationSystem.showToast('error', 'Erro na Câmera', 'Não foi possível acessar a câmera.');
            console.error('Erro ao acessar câmera:', error);
        }
    }
    
    static capturePhoto() {
        const video = document.getElementById('photo-video-capture');
        const preview = document.getElementById('photo-preview');
        if (!video || !preview) return;
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        
        const photoData = canvas.toDataURL('image/jpeg', 0.8);
        
        PessoaManager.closeCamera();
        
        preview.innerHTML = `<img src="${photoData}" alt="Foto da pessoa">`;
        preview.classList.add('has-image');
        
        PessoaManager.markPersonPhotoChanged(photoData);
        
        // Restaurar botão Câmera para estado original
        const cameraBtn = document.querySelector('#pessoas-form .photo-btn');
        if (cameraBtn) {
            cameraBtn.innerHTML = 'Câmera';
            cameraBtn.classList.remove('btn-success');
            cameraBtn.classList.add('btn-primary');
        }
    }
    
    static closeCamera() {
        if (STATE.cameraStream) {
            STATE.cameraStream.getTracks().forEach(track => track.stop());
            STATE.cameraStream = null;
        }
        STATE.cameraActive = false;
        PessoaManager.cameraState = 'idle';
        
        // Restaurar botão Câmera
        const cameraBtn = document.querySelector('#pessoas-form .photo-btn');
        if (cameraBtn) {
            cameraBtn.innerHTML = '<i class="fas fa-camera"></i> Câmera';
            cameraBtn.classList.remove('btn-success');
            cameraBtn.classList.add('btn-primary');
        }
        
        // Remover elementos de vídeo
        const video = document.getElementById('photo-video-capture');
        const captureBtn = document.getElementById('photo-capture-btn');
        const closeBtn = document.getElementById('photo-close-cam-btn');
        if (video) video.remove();
        if (captureBtn) captureBtn.remove();
        if (closeBtn) closeBtn.remove();
        
        // Restaurar placeholder se não tiver foto
        const preview = document.getElementById('photo-preview');
        if (preview && !STATE.personPhoto) {
            preview.innerHTML = `
                <div class="photo-circle-placeholder">
                    <span>Adicionar foto</span>
                </div>
            `;
        }
    }

    static showCameraModal(stream, previewId = 'photo-preview') {
        // Exibir modal de câmera com vídeo ao vivo e botões de Capturar/Cancelar
        const modal = document.createElement('div');
        modal.id = 'camera-modal';
        modal.className = 'modal camera-modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:720px;">
                <div class="modal-header">
                    <h3>Capturar Foto</h3>
                    <button class="modal-close" id="camera-close">&times;</button>
                </div>
                <div class="modal-body camera-body">
                    <video id="camera-video" autoplay playsinline style="width:100%;height:auto;background:#000;border-radius:6px;"></video>
                    <canvas id="camera-canvas" style="display:none;"></canvas>
                </div>
                <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                    <button class="btn btn-secondary" id="camera-cancel">Cancelar</button>
                    <button class="btn btn-primary" id="camera-capture">Capturar</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const video = modal.querySelector('#camera-video');
        const canvas = modal.querySelector('#camera-canvas');
        const captureBtn = modal.querySelector('#camera-capture');
        const cancelBtn = modal.querySelector('#camera-cancel');
        const closeBtn = modal.querySelector('#camera-close');

        video.srcObject = stream;

        const stopStream = () => {
            try {
                stream.getTracks().forEach(t => t.stop());
            } catch (e) {}
        };

        const removeModal = () => {
            stopStream();
            if (modal && modal.parentElement) modal.parentElement.removeChild(modal);
            STATE.cameraActive = false;
            STATE.cameraStream = null;
        };

        captureBtn.addEventListener('click', () => {
            const w = video.videoWidth;
            const h = video.videoHeight;
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, w, h);
            const dataURL = canvas.toDataURL('image/jpeg');

            const preview = document.getElementById(previewId);
            if (preview) {
                preview.innerHTML = `<img src="${dataURL}" alt="Foto">`;
                preview.style.backgroundImage = `url(${dataURL})`;
            }

            removeModal();
        });

        const cancelHandler = () => removeModal();
        cancelBtn.addEventListener('click', cancelHandler);
        closeBtn.addEventListener('click', cancelHandler);
    }
}

// ============================================
// Funções do Combobox de Empresa para Pessoa
// ============================================
function filterPessoaEmpresas(empresas, searchTerm) {
    if (!searchTerm) return empresas;
    return empresas.filter(empresa => {
        const name = (empresa.name || '').toLowerCase();
        return name.includes(searchTerm);
    });
}

function initPessoaEmpresaCombobox() {
    const input = document.getElementById('pessoa-empresa');
    const dropdown = document.getElementById('pessoa-empresa-dropdown');
    const container = document.getElementById('pessoa-empresa-container');
    const valueInput = document.getElementById('pessoa-empresa-value');
    
    if (!input || !dropdown || !container) return;

    const empresas = window.pessoaEmpresasList || [];

    // Focus - show all options
    input.addEventListener('focus', function() {
        renderPessoaEmpresaDropdown(empresas);
        dropdown.classList.add('active');
    });

    // Input - filter options
    input.addEventListener('input', function() {
        const searchTerm = this.value.toLowerCase();
        const filtered = filterPessoaEmpresas(empresas, searchTerm);
        
        renderPessoaEmpresaDropdown(filtered, searchTerm);
        dropdown.classList.add('active');
        
        // Show/hide clear button
        const clearBtn = container.querySelector('.combobox-clear');
        if (this.value) {
            clearBtn.classList.add('visible');
        } else {
            clearBtn.classList.remove('visible');
        }
    });

    // Click on container - show dropdown
    container.addEventListener('click', function(e) {
        if (!e.target.closest('.combobox-clear')) {
            if (!dropdown.classList.contains('active')) {
                renderPessoaEmpresaDropdown(empresas);
                dropdown.classList.add('active');
            }
        }
    });

    // Blur - hide dropdown (with delay for click to work)
    input.addEventListener('blur', function() {
        setTimeout(() => {
            dropdown.classList.remove('active');
        }, 200);
    });

    // Keyboard navigation
    input.addEventListener('keydown', function(e) {
        const options = dropdown.querySelectorAll('.combobox-option:not(.no-results)');
        let selectedIndex = Array.from(options).findIndex(opt => opt.classList.contains('selected'));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (selectedIndex < options.length - 1) {
                if (selectedIndex >= 0) options[selectedIndex].classList.remove('selected');
                options[selectedIndex + 1].classList.add('selected');
                options[selectedIndex + 1].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (selectedIndex > 0) {
                options[selectedIndex].classList.remove('selected');
                options[selectedIndex - 1].classList.add('selected');
                options[selectedIndex - 1].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedIndex >= 0) {
                options[selectedIndex].click();
            }
        } else if (e.key === 'Escape') {
            dropdown.classList.remove('active');
        }
    });
}

function renderPessoaEmpresaDropdown(data, manualSearchTerm = '') {
    const dropdown = document.getElementById('pessoa-empresa-dropdown');
    if (!dropdown) return;

    let html = '';

    // Add manual entry option if enabled and there's a search term
    if (manualSearchTerm) {
        html += `<div class="combobox-option manual-option" data-id="" data-name="${manualSearchTerm}" data-manual="true">
            <i class="fas fa-plus-circle"></i> Adicionar "${manualSearchTerm}"
        </div>`;
    }

    if (data.length === 0 && !manualSearchTerm) {
        dropdown.innerHTML = '<div class="combobox-option no-results">Nenhum resultado encontrado</div>';
        return;
    }

    data.forEach(item => {
        html += `<div class="combobox-option" data-id="${item.id}" data-name="${item.name}">${item.name}</div>`;
    });
    dropdown.innerHTML = html;

    // Add click handlers
    dropdown.querySelectorAll('.combobox-option:not(.no-results)').forEach(option => {
        option.addEventListener('click', function() {
            const id = this.dataset.id;
            const name = this.dataset.name;
            const isManual = this.dataset.manual === 'true';
            
            if (isManual) {
                // For manual entry, set the name but leave ID empty
                const valueInput = document.getElementById('pessoa-empresa-value');
                const input = document.getElementById('pessoa-empresa');
                const container = document.getElementById('pessoa-empresa-container');
                const clearBtn = container.querySelector('.combobox-clear');
                
                input.value = name;
                if (valueInput) {
                    valueInput.value = ''; // Empty ID for manual entry
                }
                clearBtn.classList.add('visible');
            } else {
                selectPessoaEmpresaOption(id, name);
            }
            dropdown.classList.remove('active');
        });
    });
}

function selectPessoaEmpresaOption(id, name) {
    const input = document.getElementById('pessoa-empresa');
    const valueInput = document.getElementById('pessoa-empresa-value');
    const container = document.getElementById('pessoa-empresa-container');
    const clearBtn = container.querySelector('.combobox-clear');
    
    input.value = name;
    if (valueInput) {
        // Always store as number if it's a valid numeric ID
        const numId = parseInt(id, 10);
        valueInput.value = (!isNaN(numId) && String(numId) === String(id)) ? numId : id;
    }
    clearBtn.classList.add('visible');
}

function clearPessoaEmpresa() {
    const input = document.getElementById('pessoa-empresa');
    const valueInput = document.getElementById('pessoa-empresa-value');
    const container = document.getElementById('pessoa-empresa-container');
    const clearBtn = container.querySelector('.combobox-clear');
    
    input.value = '';
    if (valueInput) {
        valueInput.value = '';
    }
    clearBtn.classList.remove('visible');
}

// ============================================
// GERENCIADOR DE VISITANTES
// ============================================

class VisitanteManager {
    static currentPage = 1;
    static totalPages = 1;
    static limit = 20;
    static total = 0;
    
    static async loadList() {
        // Obter filtro de status do select
        const statusFilter = document.getElementById('filter-visitante-status')?.value ?? 'on_premises';
        
        // Construir URL com filtros e paginação
        let url = `/visitors?page=${this.currentPage}&limit=${this.limit}`;
        if (statusFilter === 'on_premises') {
            url = `/visitors?status=on_premises&page=${this.currentPage}&limit=${this.limit}`;
        } else if (statusFilter === 'exited') {
            url = `/visitors?includeInactive=true&status=exited&page=${this.currentPage}&limit=${this.limit}`;
        } else if (statusFilter === 'inactive') {
            url = `/visitors?includeInactive=true&status=inactive&page=${this.currentPage}&limit=${this.limit}`;
        } else {
            // '' = "Todos os status" → inclui inativos e arquivados
            url = `/visitors?includeInactive=true&page=${this.currentPage}&limit=${this.limit}`;
        }
        
        const response = await api.request(url);
        let visitantes = response.success ? response.data : [];
        
        // Obter informações de paginação da resposta
        if (response.pagination) {
            this.total = response.pagination.total || 0;
            this.totalPages = response.pagination.totalPages || 1;
        } else {
            this.total = visitantes.length;
            this.totalPages = 1;
        }
        
        // Mapear photo_url para photo para exibição na listagem
        visitantes = visitantes.map(v => ({
            ...v,
            photo: v.photo || v.foto || v.photo_url || v.photo_base64 || null
        }));
        
        // Mapear photo_url para photo para exibição na listagem
        visitantes = visitantes.map(v => ({
            ...v,
            photo: v.photo || v.foto || v.photo_url || v.photo_base64 || null
        }));
        const tableBody = document.getElementById('visitantes-table-body');
        const countElement = document.getElementById('visitantes-count');
        
        if (!tableBody) return;
        
        if (!visitantes || visitantes.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center">
                        <div class="no-data">
                            <i class="fas fa-user-check"></i>
                            <p>Nenhum visitante registrado</p>
                            <button class="btn btn-primary" onclick="showVisitanteForm()">
                                Registrar primeiro visitante
                            </button>
                        </div>
                    </td>
                </tr>
            `;
            if (countElement) countElement.textContent = '0';
            return;
        }
        
        // Pré-carregar pessoas e empresas para evitar chamadas síncronas
        const pessoasList = await storage.getPessoas();
        const pessoasMap = new Map((pessoasList || []).map(p => [p.id, p]));
        // Carregar TODAS as empresas (ativas e inativas)
        const empresasList = await api.getCompanies(undefined);
        const empresasMap = new Map((empresasList || []).map(e => [e.id, e]));

        let html = '';
        const showCheckboxes = window.massInactivationMode === true;
        
        visitantes.forEach(visitante => {
            const pessoaVisitada = visitante.visited_person_id ? (pessoasMap.get(parseInt(visitante.visited_person_id)) || pessoasMap.get(visitante.visited_person_id)) : null;
            const empresaVisitada = visitante.visited_company_id ? (empresasMap.get(parseInt(visitante.visited_company_id)) || empresasMap.get(visitante.visited_company_id)) : null;
            const status = visitante.exit_date ? 'saida' : 'ativo';
            
            html += `
                <tr>
                    ${showCheckboxes ? `<td><input type="checkbox" class="visitor-checkbox" value="${visitante.id}"></td>` : ''}
                    <td>
                        ${(visitante.photo || visitante.photo_url) ?
                            `<img src="${visitante.photo || visitante.photo_url}" alt="${visitante.name}" class="user-avatar-small" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'user-avatar-placeholder',innerHTML:'<i class=\\'fas fa-user\\'></i>'}))">` :
                            `<div class="user-avatar-placeholder"><i class="fas fa-user"></i></div>`
                        }
                    </td>
                    <td>
                        <div class="user-info-cell">
                            <strong>${visitante.name || ''}</strong>
                        </div>
                    </td>
                    <td>
                        <span class="badge-matricula">
                            <i class="fas fa-id-badge"></i>
                            ${visitante.registration_number || '—'}
                        </span>
                    </td>
                    <td>${Formatter.formatCPF(visitante.document || '')}</td>
                    <td>${visitante.visitor_company || 'Não informada'}</td>
                    <td>
                        <span class="badge-cartao">
                            <i class="fas fa-id-card"></i>
                            ${visitante.card_number || 'Sem cartão'}
                        </span>
                    </td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-sm btn-edit btn-editar-visitante" data-id="${visitante.id}">
                                <i class="fas fa-edit"></i>
                            </button>
                            ${visitante.status === 'exited' && !window.location.href.includes('inativo') ? `
                                <button class="btn btn-sm btn-danger" onclick="excluirVisitante(${visitante.id})" title="Excluir Permanentemente">
                                    <i class="fas fa-trash"></i>
                                </button>
                            ` : visitante.status !== 'exited' ? `
                                <button class="btn btn-sm btn-warning" data-id="${visitante.id}" onclick="inativarVisitante(${visitante.id})" title="Inativar Visitante" style="background:#f59e0b;color:#fff">
                                    <i class="fas fa-ban"></i>
                                </button>
                            ` : `
                                <button class="btn btn-sm btn-danger" onclick="excluirVisitante(${visitante.id})" title="Excluir Permanentemente">
                                    <i class="fas fa-trash"></i>
                                </button>`}
                            <button class="btn btn-sm" style="background:#7c3aed;color:#fff" onclick="abrirModalPromover(${visitante.id})" title="Promover a Pessoa">
                                <i class="fas fa-user-plus"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        });
        
        tableBody.innerHTML = html;
        if (countElement) countElement.textContent = this.total;
        
        // Atualizar controles de paginação
        this.updatePaginationControls();
        
        // Adicionar event listeners para os botões de editar
        tableBody.querySelectorAll('.btn-editar-visitante').forEach(btn => {
            btn.addEventListener('click', function() {
                const id = parseInt(this.getAttribute('data-id'));
                window.editarVisitantePorId(id);
            });
        });
    }

    // Método para editar visitante
    static async edit(id) {
        try {
            const response = await api.request(`/visitors/${id}`);
            if (response.success && response.data) {
                const visitante = response.data;
                
                document.getElementById('visitante-id').value = visitante.id;
                document.getElementById('visitante-nome').value = visitante.name || '';
                document.getElementById('visitante-documento').value = visitante.document || '';
                document.getElementById('visitante-rg').value = visitante.rg || '';
                document.getElementById('visitante-celular').value = visitante.cellphone || '';
                document.getElementById('visitante-email').value = visitante.email || '';
                document.getElementById('visitante-empresa').value = visitante.visitor_company || '';
                document.getElementById('visitante-numero-cartao').value = visitante.card_number || '';
                document.getElementById('visitante-pessoa-visitada').value = visitante.visited_person_id || '';
                document.getElementById('visitante-empresa-visitada').value = visitante.visited_company_id || '';
                document.getElementById('visitante-motivo').value = visitante.reason || '';
                document.getElementById('visitante-data-entrada').value = visitante.entry_date ? visitante.entry_date.slice(0, 16) : '';
                
                console.log('DEBUG edit(): Campos preenchidos, chamando showVisitanteForm(' + visitante.id + ')');
                console.log('DEBUG edit(): Dados do visitante que serão exibidos:', {
                    nome: visitante.name,
                    documento: visitante.document,
                    rg: visitante.rg,
                    celular: visitante.cellphone,
                    email: visitante.email,
                    empresa: visitante.visitor_company,
                    cartao: visitante.card_number,
                    pessoaVisitada: visitante.visited_person_id,
                    empresaVisitada: visitante.visited_company_id,
                    motivo: visitante.reason,
                    entrada: visitante.entry_date
                });
                // Mostrar formulário
                if (typeof showVisitanteForm === 'function') {
                    showVisitanteForm(visitante.id);
                }
            } else {
                alert('Erro ao carregar dados do visitante');
            }
        } catch (error) {
            console.error('Erro ao carregar visitante:', error);
            alert('Erro ao carregar visitante');
        }
    }

    // Método para confirmar exclusão
    static async confirmDelete(id) {
        if (confirm('Deseja realmente excluir este visitante?')) {
            try {
                const response = await api.request(`/visitors/${id}`, {
                    method: 'DELETE'
                });
                if (response.success) {
                    alert('Visitante excluído com sucesso!');
                    this.loadList();
                } else {
                    alert('Erro ao excluir visitante: ' + (response.message || 'Erro desconhecido'));
                }
            } catch (error) {
                console.error('Erro ao excluir visitante:', error);
                alert('Erro ao excluir visitante');
            }
        }
    }
    
    // Atualizar controles de paginação
    static updatePaginationControls() {
        const prevBtn = document.getElementById('visitantes-prev-btn');
        const nextBtn = document.getElementById('visitantes-next-btn');
        const pageInfo = document.getElementById('visitantes-page-info');
        
        if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;
        if (pageInfo) pageInfo.textContent = `Página ${this.currentPage} de ${this.totalPages}`;
    }
    
    // Ir para próxima página
    static nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
            this.loadList();
        }
    }
    
    // Voltar para página anterior
    static prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.loadList();
        }
    }
    
    // Resetar para primeira página
    static resetPagination() {
        this.currentPage = 1;
        this.totalPages = 1;
        this.total = 0;
    }

    static filter() {
        // Resetar para primeira página ao filtrar
        this.resetPagination();
        
        const searchTerm = document.getElementById('search-visitantes').value.toLowerCase();
        const statusFilter = document.getElementById('filter-visitante-status').value;
        const dataFilter = document.getElementById('filter-visitante-data').value;
        
        // Construir URL com filtros e paginação
        let url;
        if (statusFilter === 'on_premises') {
            url = `/visitors?status=on_premises&page=${this.currentPage}&limit=${this.limit}`;
        } else if (statusFilter === 'exited') {
            url = `/visitors?includeInactive=true&status=exited&page=${this.currentPage}&limit=${this.limit}`;
        } else if (statusFilter === 'inactive') {
            url = `/visitors?includeInactive=true&status=inactive&page=${this.currentPage}&limit=${this.limit}`;
        } else {
            // "Todos os status" → inclui inativos
            url = `/visitors?includeInactive=true&page=${this.currentPage}&limit=${this.limit}`;
        }
        if (dataFilter) {
            url += `&startDate=${dataFilter}&endDate=${dataFilter}`;
        }
        if (searchTerm) {
            url += `&search=${encodeURIComponent(searchTerm)}`;
        }
        
        api.request(url).then(response => {
            let visitantes = response.success ? response.data : [];
            
            // Obter informações de paginação da resposta
            if (response.pagination) {
                this.total = response.pagination.total || 0;
                this.totalPages = response.pagination.totalPages || 1;
            } else {
                this.total = visitantes.length;
                this.totalPages = 1;
            }
            
            // Mapear photo_url para photo para exibição
            visitantes = visitantes.map(v => ({
                ...v,
                photo: v.photo || v.foto || v.photo_url || v.photo_base64 || null
            }));
            
            const tableBody = document.getElementById('visitantes-table-body');
            const countElement = document.getElementById('visitantes-count');
            
            if (!tableBody) return;
            
            if (!visitantes || visitantes.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center">
                            <div class="no-data">
                                <i class="fas fa-user-check"></i>
                                <p>Nenhum visitante encontrado</p>
                            </div>
                        </td>
                    </tr>
                `;
                if (countElement) countElement.textContent = '0';
                this.updatePaginationControls();
                return;
            }
            
            // Pré-carregar pessoas e empresas
            storage.getPessoas().then(pessoasList => {
                const pessoasMap = new Map((pessoasList || []).map(p => [p.id, p]));
                // Carregar TODAS as empresas (ativas e inativas)
                api.getCompanies(undefined).then(empresasList => {
                    const empresasMap = new Map((empresasList || []).map(e => [e.id, e]));
                    
                    let html = '';
                    visitantes.forEach(visitante => {
                        const pessoaVisitada = visitante.visited_person_id ? (pessoasMap.get(parseInt(visitante.visited_person_id)) || pessoasMap.get(visitante.visited_person_id)) : null;
                        const empresaVisitada = visitante.visited_company_id ? (empresasMap.get(parseInt(visitante.visited_company_id)) || empresasMap.get(visitante.visited_company_id)) : null;
                        const status = visitante.exit_date ? 'saida' : 'ativo';
                        
                        html += `
                            <tr>
                                <td>
                                    ${(visitante.photo || visitante.photo_url) ?
                                        `<img src="${visitante.photo || visitante.photo_url}" alt="${visitante.name}" class="user-avatar-small" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'user-avatar-placeholder',innerHTML:'<i class=\\'fas fa-user\\'></i>'}))">` :
                                        `<div class="user-avatar-placeholder"><i class="fas fa-user"></i></div>`
                                    }
                                </td>
                                <td>
                                    <div class="user-info-cell">
                                        <strong>${visitante.name || ''}</strong>
                                    </div>
                                </td>
                                <td>
                                    <span class="badge-matricula">
                                        <i class="fas fa-id-badge"></i>
                                        ${visitante.registration_number || '—'}
                                    </span>
                                </td>
                                <td>${Formatter.formatCPF(visitante.document || '')}</td>
                                <td>${visitante.visitor_company || 'Não informada'}</td>
                                <td>
                                    <span class="badge-cartao">
                                        <i class="fas fa-id-card"></i>
                                        ${visitante.card_number || 'Sem cartão'}
                                    </span>
                                </td>
                                <td>
                                    <div class="action-buttons">
                                        <button class="btn btn-sm btn-edit btn-editar-visitante" data-id="${visitante.id}">
                                            <i class="fas fa-edit"></i>
                                        </button>
                                        ${visitante.status === 'exited' ? `
                                            <button class="btn btn-sm btn-danger" onclick="excluirVisitante(${visitante.id})" title="Excluir Permanentemente">
                                                <i class="fas fa-trash"></i>
                                            </button>
                                        ` : `
                                            <button class="btn btn-sm btn-warning" onclick="inativarVisitante(${visitante.id})" title="Inativar Visitante" style="background:#f59e0b;color:#fff">
                                                <i class="fas fa-ban"></i>
                                            </button>
                                        `}
                                        <button class="btn btn-sm" style="background:#7c3aed;color:#fff" onclick="abrirModalPromover(${visitante.id})" title="Promover a Pessoa">
                                            <i class="fas fa-user-plus"></i>
                                        </button>
                                        ${!visitante.exit_date && visitante.status !== 'exited' ? `
                                            <button class="btn btn-sm btn-success" onclick="VisitanteManager.registrarSaida(${visitante.id})">
                                                <i class="fas fa-sign-out-alt"></i>
                                            </button>
                                        ` : ''}
                                    </div>
                                </td>
                            </tr>
                        `;
                    });
                    
                    tableBody.innerHTML = html;
                    if (countElement) countElement.textContent = this.total;
                    
                    // Atualizar controles de paginação
                    this.updatePaginationControls();
                    
                    // Adicionar event listeners para os botões de editar
                    tableBody.querySelectorAll('.btn-editar-visitante').forEach(btn => {
                        btn.addEventListener('click', function() {
                            const id = parseInt(this.getAttribute('data-id'));
                            window.editarVisitantePorId(id);
                        });
                    });
                });
            });
        });
    }

    static async showForm(id = null) {
        console.log('DEBUG showForm: Início - id:', id);
        
        // Verificar se elementos existem (podem não existir em outras páginas)
        const visitantesList = document.getElementById('visitantes-list');
        const visitantesForm = document.getElementById('visitantes-form');
        
        if (!visitantesList || !visitantesForm) return;
        
        visitantesList.classList.add('hidden');
        visitantesForm.classList.remove('hidden');
        
        const title = document.getElementById('form-visitante-title');
        if (title) {
            title.textContent = id ? 'Editar Visitante' : 'Novo Visitante';
        }
        
        this.clearForm();
        
        if (id) {
            STATE.editMode = true;
            STATE.currentEditId = id;
            await this.loadFormData(id);
        } else {
            STATE.editMode = false;
            STATE.currentEditId = null;
            // Definir data/hora atual para entrada
            const now = new Date();
            const localDateTime = now.toISOString().slice(0, 16);
            document.getElementById('visitante-data-entrada').value = localDateTime;
        }
        
        // Carregar selects
        await this.loadPessoaSelect();
        await this.loadEmpresaSelect();

        UIManager.switchFormTab('visitante-dados-tab');

        // Garantir que o container de abas do formulário esteja visível
        const tabContent = document.querySelector('#visitantes-form .tab-content');
        if (tabContent) tabContent.classList.add('active');
    }

    static showList() {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const visitantesList = document.getElementById('visitantes-list');
        const visitantesForm = document.getElementById('visitantes-form');
        
        if (!visitantesList || !visitantesForm) return;
        
        // Limpar formulário ao fechar
        this.clearForm();
        
        visitantesList.classList.remove('hidden');
        visitantesForm.classList.add('hidden');
        this.loadList();
        // Remover classe active do container de abas do formulário para escondê-lo
        const tabContent = document.querySelector('#visitantes-form .tab-content');
        if (tabContent) tabContent.classList.remove('active');
    }

    static clearForm() {
        const form = document.getElementById('form-visitante');
        if (form) {
            form.reset();
        }
        
        // Limpar cache da foto
        STATE.visitorPhoto = null;
        
        const preview = document.getElementById('visitante-photo-preview');
        if (preview) {
            preview.innerHTML = `
                <div class="photo-circle-placeholder">
                    <i class="fas fa-camera"></i>
                    <span>Foto</span>
                </div>
            `;
            preview.classList.remove('has-image');
        }
    }

    static async loadFormData(id) {
        console.log('DEBUG loadFormData: Buscando visitante ID:', id);
        // Buscar dados da API diretamente para ter dados atualizados
        const response = await api.request(`/visitors/${id}`);
        console.log('DEBUG loadFormData: Response da API:', response);
        
        if (!response.success || !response.data) {
            console.error('DEBUG loadFormData: Erro ao carregar dados do visitante');
            return;
        }
        
        const visitante = response.data;
        console.log('DEBUG loadFormData: Dados do visitante:', visitante);
        console.log('DEBUG loadFormData: period_start:', visitante.period_start);
        console.log('DEBUG loadFormData: period_end:', visitante.period_end);
        console.log('DEBUG loadFormData: liberation_type:', visitante.liberation_type);
        
        document.getElementById('visitante-id').value = visitante.id;
        document.getElementById('visitante-nome').value = visitante.name || '';
        document.getElementById('visitante-documento').value = visitante.document || '';
        document.getElementById('visitante-rg').value = visitante.rg || '';
        document.getElementById('visitante-celular').value = visitante.cellphone || '';
        document.getElementById('visitante-email').value = visitante.email || '';
        document.getElementById('visitante-empresa').value = visitante.visitor_company || '';
        document.getElementById('visitante-pessoa-visitada').value = visitante.visited_person_id || '';
        document.getElementById('visitante-empresa-visitada').value = visitante.visited_company_id || '';
        document.getElementById('visitante-motivo').value = visitante.reason || '';
        
        // Carregar tipo de liberação e período
        console.log('DEBUG loadFormData: Verificando liberation_type:', visitante.liberation_type);
        if (visitante.liberation_type) {
            const radioLiberacao = document.querySelector('input[name="tipoLiberacao"][value="' + visitante.liberation_type + '"]');
            console.log('DEBUG loadFormData: Radio liberation_type encontrado:', radioLiberacao);
            if (radioLiberacao) {
                radioLiberacao.checked = true;
                togglePeriodo();
            }
            if (visitante.liberation_type === 'periodo' && visitante.period_start) {
                const valorDataInicio = visitante.period_start.slice(0, 16);
                console.log('DEBUG loadFormData: Definindo dataInicio:', valorDataInicio);
                document.getElementById('visitante-data-entrada').value = valorDataInicio;
            }
            if (visitante.liberation_type === 'periodo' && visitante.period_end) {
                const valorDataFim = visitante.period_end.slice(0, 16);
                console.log('DEBUG loadFormData: Definindo dataFim:', valorDataFim);
                document.getElementById('visitante-data-saida').value = valorDataFim;
            }
        } else {
            // Se não tem liberation_type, define como única por padrão
            console.log('DEBUG loadFormData: Sem liberation_type, definindo como unica');
            const radioUnica = document.querySelector('input[name="tipoLiberacao"][value="unica"]');
            if (radioUnica) {
                radioUnica.checked = true;
                togglePeriodo();
            }
        }
        
        if (visitante.dataEntrada) {
            const localDateTime = new Date(visitante.dataEntrada).toISOString().slice(0, 16);
            document.getElementById('visitante-data-entrada').value = localDateTime;
        }
        
        if (visitante.exit_date || visitante.dataSaida) {
            const localDateTime = new Date(visitante.exit_date || visitante.dataSaida).toISOString().slice(0, 16);
            document.getElementById('visitante-data-saida').value = localDateTime;
        }
        
        if (visitante.foto || visitante.photo_url) {
            const preview = document.getElementById('visitante-photo-preview');
            const fotoUrl = visitante.foto || visitante.photo_url;
            preview.innerHTML = `<img src="${fotoUrl}" alt="${visitante.name}" onerror="onVisitorPhotoError(this)">`;
            preview.classList.add('has-image');
            // Armazenar no cache
            STATE.visitorPhoto = fotoUrl;
        }
    }

    static async loadPessoaSelect() {
        const select = document.getElementById('visitante-pessoa-visitada');
        if (!select) return;

        try {
            const pessoas = await storage.getPessoas();
            let options = '<option value="">Selecione uma pessoa</option>';
            pessoas.forEach(pessoa => {
                const nome = pessoa.nome || pessoa.name || pessoa.full_name || 'Pessoa';
                const matricula = pessoa.matricula || pessoa.registration_number || pessoa.registrationNumber || '';
                options += `<option value="${pessoa.id}">${nome} (${matricula})</option>`;
            });
            select.innerHTML = options;
        } catch (error) {
            console.error('Erro ao carregar select de pessoas:', error);
            select.innerHTML = '<option value="">Erro ao carregar pessoas</option>';
        }
    }

    static async loadEmpresaSelect() {
        const select = document.getElementById('visitante-empresa-visitada');
        if (!select) return;

        try {
            // Carregar TODAS as empresas (ativas e inativas)
            const empresas = await api.getCompanies(undefined);
            let options = '<option value="">Selecione uma empresa</option>';
            empresas.forEach(empresa => {
                const name = empresa.corporate_name || empresa.razaoSocial || empresa.trading_name || empresa.nomeFantasia || 'Empresa';
                const inactive = empresa.active === false ? ' (Inativa)' : '';
                options += `<option value="${empresa.id}">${name}${inactive}</option>`;
            });
            select.innerHTML = options;
        } catch (error) {
            console.error('Erro ao carregar select de empresas (visitante):', error);
            select.innerHTML = '<option value="">Erro ao carregar empresas</option>';
        }
    }

    static async save(event) {
        event.preventDefault();
        
        // Validar CPF
        const documento = document.getElementById('visitante-documento').value;
        if (documento && !InputMask.validateCPF(documento)) {
            NotificationSystem.showToast('error', 'CPF Inválido', 'Por favor, insira um CPF válido.');
            return;
        }
        
        const visitante = {
            id: STATE.editMode ? parseInt(document.getElementById('visitante-id').value) : null,
            nome: document.getElementById('visitante-nome').value,
            documento: documento,
            rg: document.getElementById('visitante-rg').value,
            celular: document.getElementById('visitante-celular').value,
            email: document.getElementById('visitante-email').value,
            empresa: document.getElementById('visitante-empresa').value,
            pessoaVisitadaId: document.getElementById('visitante-pessoa-visitada').value || null,
            empresaVisitadaId: document.getElementById('visitante-empresa-visitada').value || null,
            motivo: document.getElementById('visitante-motivo').value,
            dataEntrada: document.getElementById('visitante-data-entrada').value,
            dataSaida: document.getElementById('visitante-data-saida').value || null,
            foto: this.getPhotoData(),
            photo_base64: this.getPhotoData(),
            dataAtualizacao: new Date().toISOString()
        };
        
        try {
            const savedVisitante = await storage.saveVisitante(visitante);
            
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Visitante Atualizado' : 'Visitante Registrado',
                `${savedVisitante.nome} foi ${STATE.editMode ? 'atualizado' : 'registrado'} com sucesso!`
            );
            
            this.showList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao salvar visitante:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o visitante. Tente novamente.');
        }
    }

    static getPhotoData() {
        // Primeiro verificar se tem foto em cache (STATE)
        if (STATE.visitorPhoto) {
            return STATE.visitorPhoto;
        }
        // Fallback: verificar no elemento DOM
        const preview = document.getElementById('visitante-photo-preview');
        const img = preview ? preview.querySelector('img') : null;
        return img ? img.src : null;
    }

    static edit(id) {
        this.showForm(id);
    }

    static async confirmDelete(id) {
        const visitante = await storage.getVisitante(id);
        if (!visitante) return;

        const displayName = visitante.nome || visitante.name || visitante.document || 'registro';
        UIManager.showModal(
            'Confirmar Exclusão',
            `Tem certeza que deseja excluir "${displayName}"? Esta ação não pode ser desfeita.`,
            () => this.delete(id)
        );
    }

    static delete(id) {
        storage.deleteVisitante(id);
        NotificationSystem.showToast('success', 'Visitante Excluído', 'Visitante excluído com sucesso.');
        this.loadList();
        DashboardManager.load();
        UIManager.updateBadges();
    }

    static async registrarSaida(id) {
        const visitante = await storage.getVisitante(id);
        if (!visitante) return;

        visitante.exit_date = new Date().toISOString();
        await storage.saveVisitante(visitante);

        NotificationSystem.showToast('success', 'Saída Registrada', `Saída de ${visitante.nome} registrada com sucesso.`);
        this.loadList();
        DashboardManager.load();
    }

    static handlePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const validTypes = ['image/jpeg', 'image/png', 'image/gif'];
        if (!validTypes.includes(file.type)) {
            NotificationSystem.showToast('error', 'Formato Inválido', 'Apenas imagens JPG, PNG ou GIF são permitidas.');
            return;
        }
        
        if (file.size > 2 * 1024 * 1024) {
            NotificationSystem.showToast('error', 'Arquivo Grande', 'A imagem deve ter no máximo 2MB.');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.getElementById('visitante-photo-preview');
            preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
        };
        reader.readAsDataURL(file);
    }

    static openFilePicker() {
        document.getElementById('visitante-photo-input').click();
    }

    static async openCamera() {
        try {
            // Se já está no modo de captura, confirmar a foto
            if (STATE.visitorCameraState === 'capturing') {
                VisitanteManager.capturePhoto();
                return;
            }
            
            // Se já tem foto capturada, permitir substituir
            if (STATE.visitorPhoto) {
                // Limpar foto anterior e continuar para capturar nova
                STATE.visitorPhoto = null;
            }
            
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            STATE.cameraActive = true;
            STATE.cameraStream = stream;
            
            // Criar vídeo para capturar foto diretamente no círculo
            const preview = document.getElementById('visitante-photo-preview');
            if (!preview) return;
            
            // Criar elemento de vídeo
            const video = document.createElement('video');
            video.id = 'visitante-video-capture';
            video.autoplay = true;
            video.playsInline = true;
            video.style.cssText = 'width: 100%; height: 100%; object-fit: cover; border-radius: 50%;';
            
            // Substituir conteúdo do círculo
            preview.innerHTML = '';
            preview.appendChild(video);
            
            video.srcObject = stream;
            
            // Atualizar estado
            STATE.visitorCameraState = 'capturing';
            
            // Atualizar texto do botão Câmera para indicar que precisa confirmar
            const cameraBtn = document.querySelector('#visitantes-form .photo-btn');
            if (cameraBtn) {
                cameraBtn.innerHTML = '<i class="fas fa-upload"></i> Upload';
                cameraBtn.classList.remove('btn-primary');
                cameraBtn.classList.add('btn-success');
            }
            
            // Atualizar label do círculo
            const placeholder = preview.querySelector('.photo-circle-placeholder');
            if (placeholder) {
                placeholder.innerHTML = '<i class="fas fa-camera"></i><span>Clique em Confirmar</span>';
            }
            
            // Criar botão de capturar
            const captureBtn = document.createElement('button');
            captureBtn.id = 'visitante-capture-btn';
            captureBtn.onclick = (e) => { e.stopPropagation(); VisitanteManager.capturePhoto(); };
            preview.appendChild(captureBtn);
            
            // Criar botão de fechar
            const closeBtn = document.createElement('button');
            closeBtn.id = 'visitante-close-cam-btn';
            closeBtn.innerHTML = '<i class="fas fa-times"></i>';
            closeBtn.style.cssText = 'position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 50%; background: rgba(0,0,0,0.5); color: white; border: none; cursor: pointer; z-index: 10;';
            closeBtn.onclick = (e) => { e.stopPropagation(); VisitanteManager.closeCamera(); };
            preview.appendChild(closeBtn);
            
        } catch (error) {
            NotificationSystem.showToast('error', 'Erro na Câmera', 'Não foi possível acessar a câmera.');
            console.error('Erro ao acessar câmera (visitante):', error);
        }
    }
    
    static capturePhoto() {
        const video = document.getElementById('visitante-video-capture');
        const preview = document.getElementById('visitante-photo-preview');
        if (!video || !preview) return;
        
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        
        const photoData = canvas.toDataURL('image/jpeg', 0.8);
        
        VisitanteManager.closeCamera();
        
        preview.innerHTML = `<img src="${photoData}" alt="Foto do visitante">`;
        preview.classList.add('has-image');
        
        STATE.visitorPhoto = photoData;
    }
    
    static closeCamera() {
        if (STATE.cameraStream) {
            STATE.cameraStream.getTracks().forEach(track => track.stop());
            STATE.cameraStream = null;
        }
        STATE.cameraActive = false;
        STATE.visitorCameraState = null;
        
        // Remover elementos de vídeo
        const preview = document.getElementById('visitante-photo-preview');
        const video = document.getElementById('visitante-video-capture');
        const captureBtn = document.getElementById('visitante-capture-btn');
        const closeBtn = document.getElementById('visitante-close-cam-btn');
        if (video) video.remove();
        if (captureBtn) captureBtn.remove();
        if (closeBtn) closeBtn.remove();
        
        // Restaurar placeholder
        if (preview && !preview.classList.contains('has-image')) {
            preview.innerHTML = `
                <div class="photo-circle-placeholder">
                    <i class="fas fa-camera"></i>
                    <span>Adicionar foto</span>
                </div>
            `;
        }
        
        // Restaurar botão
        const cameraBtn = document.querySelector('#visitantes-form .photo-btn');
        if (cameraBtn) {
            cameraBtn.innerHTML = '<i class="fas fa-upload"></i> Upload';
            cameraBtn.classList.remove('btn-success');
            cameraBtn.classList.add('btn-primary');
        }
    }
}

// ============================================
// GERENCIADOR DE GRUPOS
// ============================================

class GrupoManager {
    static async loadList() {
        try {
            const response = await storage.getGrupos();
            // Extrair array de grupos da resposta
            const gruposBackend = response?.data || (Array.isArray(response) ? response : []);
            
            // Buscar o cards-grid dentro da seção de grupos
            const gruposList = document.getElementById('grupos-list');
            if (!gruposList) return;
            
            const cardsGrid = gruposList.querySelector('.cards-grid');
            if (!cardsGrid) return;
            
            const tableBody = document.getElementById('grupos-table-body');
            
            // Mapear tipos para exibição
            const tipoLabels = {
                'block': 'Bloco',
                'room': 'Sala',
                'department': 'Departamento',
                'unit': 'Unidade',
                'other': 'Outro'
            };
            
            const tipoClasses = {
                'block': 'badge-block',
                'room': 'badge-room',
                'department': 'badge-department',
                'unit': 'badge-unit',
                'other': 'badge-other'
            };
            
            if (!gruposBackend || gruposBackend.length === 0) {
                cardsGrid.innerHTML = `
                    <div class="no-data">
                        <i class="fas fa-layer-group"></i>
                        <p>Nenhum grupo cadastrado</p>
                        <button class="btn btn-primary" onclick="showGrupoForm()">
                            Criar primeiro grupo
                        </button>
                    </div>
                `;
                if (tableBody) {
                    tableBody.innerHTML = `
                        <tr>
                            <td colspan="6" class="text-center">Nenhum grupo cadastrado</td>
                        </tr>
                    `;
                }
                return;
            }
            
            let html = '';
            let tableHtml = '';
            gruposBackend.forEach(grupo => {
                // person_count vem do backend agora
                const pessoasNoGrupo = grupo.person_count || 0;
                
                const tipoDisplay = grupo.type ? (tipoLabels[grupo.type] || grupo.type) : 'Grupo';
                const tipoClass = tipoClasses[grupo.type] || '';
                
                html += `
                    <div class="card grupo-card">
                        <div class="grupo-card-header">
                            <div class="grupo-icon">
                                <i class="fas fa-layer-group"></i>
                            </div>
                            <div class="grupo-info">
                                <h3>${grupo.name || grupo.nome}</h3>
                                <p>${tipoDisplay}</p>
                            </div>
                        </div>
                        <div class="grupo-card-body">
                            <p class="grupo-descricao">${grupo.description || grupo.descricao || 'Sem descrição'}</p>
                            <div class="grupo-stats">
                                <div class="grupo-stat">
                                    <i class="fas fa-users"></i>
                                    <span>${pessoasNoGrupo} pessoa${pessoasNoGrupo !== 1 ? 's' : ''}</span>
                                </div>
                                <div class="grupo-stat">
                                    <i class="fas fa-calendar"></i>
                                    <span>${Formatter.formatDate(grupo.created_at || grupo.dataCriacao)}</span>
                                </div>
                            </div>
                        </div>
                        <div class="grupo-card-actions">
                            <button class="btn btn-sm btn-edit" onclick="GrupoManager.edit(${grupo.id})">
                                <i class="fas fa-edit"></i> Editar
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="GrupoManager.confirmDelete(${grupo.id})">
                                <i class="fas fa-trash"></i> Excluir
                            </button>
                        </div>
                    </div>
                `;
                
                // Renderizar linha na tabela
                tableHtml += `
                    <tr>
                        <td><strong>${grupo.name || grupo.nome}</strong></td>
                        <td><span class="badge ${tipoClass}">${tipoDisplay}</span></td>
                        <td>${pessoasNoGrupo} pessoa${pessoasNoGrupo !== 1 ? 's' : ''}</td>
                        <td>
                            <button class="btn btn-sm btn-secondary" onclick="GrupoManager.edit(${grupo.id})" title="Editar">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="GrupoManager.confirmDelete(${grupo.id})" title="Excluir">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
        
            cardsGrid.innerHTML = html;
            if (tableBody) {
                tableBody.innerHTML = tableHtml;
            }
        } catch (error) {
            console.error('Erro ao carregar grupos:', error);
            const cardsGrid = document.querySelector('.cards-grid');
            if (cardsGrid) {
                cardsGrid.innerHTML = `
                    <div class="no-data">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Erro ao carregar grupos</p>
                    </div>
                `;
            }
        }
    }
    
    static toggleLayout() {
        const cardsGrid = document.getElementById('grupos-cards-container');
        const listContainer = document.getElementById('grupos-list-container');
        const toggleBtn = document.getElementById('grupos-layout-toggle');
        const icon = document.getElementById('grupos-layout-icon');
        const text = document.getElementById('grupos-layout-text');
        
        if (cardsGrid && listContainer) {
            const isCardsView = !cardsGrid.classList.contains('hidden');
            
            if (isCardsView) {
                // Mudar para lista
                cardsGrid.classList.add('hidden');
                listContainer.classList.remove('hidden');
                if (icon) icon.className = 'fas fa-list';
                if (text) text.textContent = 'Lista';
                // Renderizar lista
                this.renderListView();
            } else {
                // Mudar para cards
                cardsGrid.classList.remove('hidden');
                listContainer.classList.add('hidden');
                if (icon) icon.className = 'fas fa-th';
                if (text) text.textContent = 'Cards';
            }
        }
    }
    
    static async renderListView() {
        try {
            const response = await storage.getGrupos();
            // Extrair array de grupos da resposta
            const gruposBackend = response?.data || (Array.isArray(response) ? response : []);
            
            const tableBody = document.getElementById('grupos-table-body');
            if (!tableBody) return;
            
            // Mapear tipos para exibição
            const tipoLabels = {
                'block': 'Bloco',
                'room': 'Sala',
                'department': 'Departamento',
                'unit': 'Unidade',
                'other': 'Outro'
            };
            
            if (!gruposBackend || gruposBackend.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center">Nenhum grupo cadastrado</td>
                    </tr>
                `;
                return;
            }
            
            let html = '';
            gruposBackend.forEach(grupo => {
                const pessoasNoGrupo = grupo.person_count || 0;
                const tipoDisplay = grupo.type ? (tipoLabels[grupo.type] || grupo.type) : 'Grupo';
                
                html += `
                    <tr>
                        <td>${grupo.name || grupo.nome}</td>
                        <td>${tipoDisplay}</td>
                        <td>${pessoasNoGrupo}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="btn btn-sm btn-edit" onclick="GrupoManager.edit(${grupo.id})">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn btn-sm btn-danger" onclick="GrupoManager.confirmDelete(${grupo.id})">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
            
            tableBody.innerHTML = html;
        } catch (error) {
            console.error('Erro ao renderizar lista de grupos:', error);
        }
    }

    static async showForm(id = null) {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const gruposList = document.getElementById('grupos-list');
        const gruposForm = document.getElementById('grupos-form');
        
        if (!gruposList || !gruposForm) return;
        
        gruposList.classList.add('hidden');
        gruposForm.classList.remove('hidden');
        
        const title = document.getElementById('form-grupo-title');
        if (title) {
            title.textContent = id ? 'Editar Grupo' : 'Novo Grupo';
        }
        
        this.clearForm();
        
        if (id) {
            STATE.editMode = true;
            STATE.currentEditId = id;
            await this.loadFormData(id);
        } else {
            STATE.editMode = false;
            STATE.currentEditId = null;
        }
    }

    static showList() {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const gruposList = document.getElementById('grupos-list');
        const gruposForm = document.getElementById('grupos-form');
        
        if (!gruposList || !gruposForm) return;
        
        gruposList.classList.remove('hidden');
        gruposForm.classList.add('hidden');
        this.loadList();
    }

    static clearForm() {
        const form = document.getElementById('form-grupo');
        if (form) {
            form.reset();
        }
    }

    static async loadFormData(id) {
        try {
            console.log('loadFormData - carregando grupo ID:', id);
            const grupo = await storage.getGrupo(id);
            console.log('loadFormData - dados do grupo:', grupo);
            if (!grupo) return;
            
            // Mapear campos do backend para o frontend
            document.getElementById('grupo-id').value = grupo.id;
            document.getElementById('grupo-nome').value = grupo.name || grupo.nome || '';
            document.getElementById('grupo-tipo').value = grupo.type || grupo.tipo || '';
            document.getElementById('grupo-descricao').value = grupo.description || grupo.descricao || '';
            
            // Carregar e-mails
            const emails = grupo.emails || [];
            console.log('loadFormData - emails do grupo:', emails);
            for (let i = 1; i <= 4; i++) {
                const emailInput = document.getElementById(`email-${i}`);
                if (emailInput) {
                    emailInput.value = emails[i - 1] || '';
                }
            }
        } catch (error) {
            console.error('Erro ao carregar dados do grupo:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível carregar os dados do grupo.');
        }
    }

    static async save(event) {
        event.preventDefault();
        
        // Obter e-mails do formulário
        const emails = [];
        for (let i = 1; i <= 4; i++) {
            const emailInput = document.getElementById(`email-${i}`);
            if (emailInput && emailInput.value.trim()) {
                emails.push(emailInput.value.trim());
            }
        }
        console.log('save - emails coletados:', emails);
        
        const grupo = {
            id: STATE.editMode ? parseInt(document.getElementById('grupo-id').value) : null,
            nome: document.getElementById('grupo-nome').value,
            tipo: document.getElementById('grupo-tipo').value,
            descricao: document.getElementById('grupo-descricao').value,
            emails: emails,
            dataCriacao: STATE.editMode ? (await storage.getGrupo(STATE.currentEditId)).dataCriacao : new Date().toISOString()
        };
        console.log('save - grupo a salvar:', grupo);
        
        try {
            const savedGrupo = await storage.saveGrupo(grupo);
            console.log('save - grupo salvo:', savedGrupo);
            
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Grupo Atualizado' : 'Grupo Criado',
                `Grupo "${savedGrupo.nome}" foi ${STATE.editMode ? 'atualizado' : 'criado'} com sucesso!`
            );
            
            this.showList();
            DashboardManager.load();
            UIManager.updateBadges();
            
            // Atualizar labels se necessário
            storage.updateLabels();
        } catch (error) {
            console.error('Erro ao salvar grupo:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o grupo. Tente novamente.');
        }
    }

    static edit(id) {
        this.showForm(id);
    }

    static async confirmDelete(id) {
        try {
            const grupo = await storage.getGrupo(id);
            if (!grupo) return;

            // O backend já fornece person_count
            const pessoasNoGrupo = grupo.person_count || 0;
            
            if (pessoasNoGrupo > 0) {
                NotificationSystem.showToast(
                    'warning',
                    'Grupo em Uso',
                    `Este grupo tem ${pessoasNoGrupo} pessoa(s) vinculada(s). Remova as pessoas antes de excluir o grupo.`
                );
                return;
            }
            
            const displayName = grupo.nome || grupo.name || 'grupo';
            UIManager.showModal(
                'Confirmar Exclusão',
                `Tem certeza que deseja excluir o grupo "${displayName}"?`,
                () => this.delete(id)
            );
        } catch (error) {
            console.error('Erro ao verificar grupo:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível verificar o grupo.');
        }
    }

    static async delete(id) {
        try {
            // Deletar grupo no backend
            const result = await storage.deleteGrupo(id);
            
            if (!result) {
                throw new Error('Falha ao deletar grupo');
            }
            
            NotificationSystem.showToast('success', 'Grupo Excluído', 'Grupo excluído com sucesso.');
            
            // Recarregar dados do backend para sincronizar
            await this.loadList();
            await DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao excluir grupo:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível excluir o grupo.');
        }
    }

    static async filter() {
        try {
            const searchTerm = document.getElementById('search-grupos').value.toLowerCase();
            const response = await storage.getGrupos();
            const gruposBackend = response?.data || (Array.isArray(response) ? response : []);
            
            // Mapear grupos do backend para o formato do frontend
            const grupos = gruposBackend.map(grupo => ({
                id: grupo.id,
                nome: grupo.name || grupo.nome,
                tipo: grupo.type || grupo.tipo,
                descricao: grupo.description || grupo.descricao,
                dataCriacao: grupo.created_at || grupo.dataCriacao,
                active: grupo.active
            }));
            
            const filtered = grupos.filter(grupo => 
                grupo.nome.toLowerCase().includes(searchTerm) || 
                (grupo.descricao && grupo.descricao.toLowerCase().includes(searchTerm))
            );
            
            const gruposList = document.getElementById('grupos-list');
            if (!gruposList) return;
            
            const cardsGrid = gruposList.querySelector('.cards-grid');
            if (!cardsGrid) return;
            
            // Mapear tipos para exibição
            const tipoLabels = {
                'block': 'Bloco',
                'room': 'Sala',
                'department': 'Departamento',
                'unit': 'Unidade',
                'other': 'Outro'
            };
            
            if (filtered.length === 0) {
                cardsGrid.innerHTML = `
                    <div class="no-data">
                        <i class="fas fa-search"></i>
                        <p>Nenhum grupo encontrado</p>
                    </div>
                `;
                return;
            }
            
            let html = '';
            filtered.forEach(grupo => {
                const pessoas = storage.get('pessoas') || [];
                const pessoasNoGrupo = pessoas.filter(p => p.grupoId === grupo.id).length;
                
                const tipoDisplay = grupo.tipo ? (tipoLabels[grupo.tipo] || grupo.tipo) : 'Grupo';
                
                html += `
                    <div class="card grupo-card">
                        <div class="grupo-card-header">
                            <div class="grupo-icon">
                                <i class="fas fa-layer-group"></i>
                            </div>
                            <div class="grupo-info">
                                <h3>${grupo.nome}</h3>
                                <p>${tipoDisplay}</p>
                            </div>
                        </div>
                        <div class="grupo-card-body">
                            <p class="grupo-descricao">${grupo.descricao || 'Sem descrição'}</p>
                            <div class="grupo-stats">
                                <div class="grupo-stat">
                                    <i class="fas fa-users"></i>
                                    <span>${pessoasNoGrupo} pessoa${pessoasNoGrupo !== 1 ? 's' : ''}</span>
                                </div>
                                <div class="grupo-stat">
                                    <i class="fas fa-calendar"></i>
                                    <span>${Formatter.formatDate(grupo.dataCriacao)}</span>
                                </div>
                            </div>
                        </div>
                        <div class="grupo-card-actions">
                            <button class="btn btn-sm btn-edit" onclick="GrupoManager.edit(${grupo.id})">
                                <i class="fas fa-edit"></i> Editar
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="GrupoManager.confirmDelete(${grupo.id})">
                                <i class="fas fa-trash"></i> Excluir
                            </button>
                        </div>
                    </div>
                `;
            });
            
            cardsGrid.innerHTML = html;
        } catch (error) {
            console.error('Erro ao filtrar grupos:', error);
        }
    }

    // -----------------------------------------------------------
    // Inicialização - aguarda token e carrega lista de grupos
    // -----------------------------------------------------------
    static init() {
        console.log('GrupoManager.init: inicializando...');
        
        // Aguarda o token estar disponível - verificar todas as chaves possíveis
        const checkToken = () => {
            const token = localStorage.getItem('mamcontrol_accessToken') || localStorage.getItem('token') || 
                          localStorage.getItem('authToken') || 
                          localStorage.getItem('access_token') ||
                          localStorage.getItem('mamcontrol_accessToken');
            return !!token;
        };
        
        const tryInit = () => {
            if (checkToken()) {
                console.log('GrupoManager.init: token disponível, carregando lista...');
                this.loadList();
            } else {
                console.log('GrupoManager.init: token não encontrado, tentando novamente em 100ms...');
                setTimeout(tryInit, 100);
            }
        };
        
        // Inicia verificação
        setTimeout(tryInit, 0);
    }
}

// ============================================
// GERENCIADOR DE EMPRESAS
// ============================================

class EmpresaManager {
    static currentPage = 1;
    static totalPages = 1;
    static limit = 20;
    static total = 0;
    static allEmpresas = [];
    static filteredEmpresas = [];
    static searchTerm = '';
    
    static async loadList() {
        try {
            // Buscar todas as empresas para filtragem local
            const allResponse = await api.request('/companies?limit=10000');
            this.allEmpresas = allResponse.success ? allResponse.data : [];
            this.applyLocalFilter();
            
            // Aplicar paginação local nos dados filtrados
            const startIndex = (this.currentPage - 1) * this.limit;
            const endIndex = startIndex + this.limit;
            const empresasBackend = this.filteredEmpresas.slice(startIndex, endIndex);
            
            // Atualizar contadores de paginação
            this.total = this.filteredEmpresas.length;
            this.totalPages = Math.ceil(this.total / this.limit) || 1;
            
            const tableBody = document.getElementById('empresas-table-body');
            const countElement = document.getElementById('empresas-count');
            
            if (!tableBody) return;
            
            // Mapear empresas do backend para o formato do frontend
            const empresas = empresasBackend.map(empresa => ({
                id: empresa.id,
                razaoSocial: empresa.corporate_name || empresa.razaoSocial,
                nomeFantasia: empresa.trading_name || empresa.nomeFantasia,
                cnpj: empresa.cnpj,
                proprietarios: empresa.owners ? empresa.owners.map(o => o.id) : [],
                active: empresa.active
            }));
            
            if (empresas.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center">
                            <div class="no-data">
                                <i class="fas fa-building"></i>
                                <p>Nenhuma empresa cadastrada</p>
                                <button class="btn btn-primary" onclick="showEmpresaForm()">
                                    Cadastrar primeira empresa
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
                if (countElement) countElement.textContent = '0';
                this.updatePaginationControls();
                return;
            }
            
            let html = '';
            for (const empresa of empresas) {
                // Buscar nomes dos proprietários
                const proprietariosNomes = [];
                if (empresa.proprietarios && empresa.proprietarios.length > 0) {
                    for (const personId of empresa.proprietarios) {
                        try {
                            const pessoa = await storage.getPessoa(personId);
                            if (pessoa) {
                                proprietariosNomes.push(pessoa.nome || pessoa.name || 'Desconhecido');
                            }
                        } catch (error) {
                            console.warn('Erro ao buscar proprietário:', error);
                        }
                    }
                }
                
                html += `
                    <tr>
                        <td>
                            <div class="empresa-info-cell">
                                <strong>${empresa.razaoSocial}</strong>
                                <small>${empresa.nomeFantasia || 'Sem nome fantasia'}</small>
                            </div>
                        </td>
                        <td>${empresa.nomeFantasia || '-'}</td>
                        <td>${Formatter.formatCNPJ(empresa.cnpj)}</td>
                        <td>
                            <div class="action-buttons">
                                <button class="btn btn-sm btn-edit" onclick="EmpresaManager.edit(${empresa.id})">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn btn-sm btn-danger" onclick="EmpresaManager.confirmDelete(${empresa.id})">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }
            
            tableBody.innerHTML = html;
            if (countElement) countElement.textContent = this.total;
            
            // Atualizar controles de paginação
            this.updatePaginationControls();
        } catch (error) {
            console.error('Erro ao carregar empresas:', error);
            const tableBody = document.getElementById('empresas-table-body');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center text-error">Erro ao carregar empresas</td>
                    </tr>
                `;
            }
        }
    }
    
    // Aplicar filtro local
    static applyLocalFilter() {
        this.filteredEmpresas = this.allEmpresas.filter(empresa => {
            const razaoSocial = (empresa.corporate_name || empresa.razaoSocial || '').toLowerCase();
            const nomeFantasia = (empresa.trading_name || empresa.nomeFantasia || '').toLowerCase();
            const cnpj = empresa.cnpj || '';
            
            return !this.searchTerm || 
                   razaoSocial.includes(this.searchTerm) ||
                   nomeFantasia.includes(this.searchTerm) ||
                   cnpj.includes(this.searchTerm);
        });
    }
    
    // Atualizar controles de paginação
    static updatePaginationControls() {
        const prevBtn = document.getElementById('empresas-prev-btn');
        const nextBtn = document.getElementById('empresas-next-btn');
        const pageInfo = document.getElementById('empresas-page-info');
        
        if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;
        if (pageInfo) pageInfo.textContent = `Página ${this.currentPage} de ${this.totalPages}`;
    }
    
    // Ir para próxima página
    static nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
            this.loadList();
        }
    }
    
    // Voltar para página anterior
    static prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            this.loadList();
        }
    }
    
    // Resetar para primeira página
    static resetPagination() {
        this.currentPage = 1;
    }

    static async filter() {
        // Resetar para primeira página ao filtrar
        this.resetPagination();
        this.searchTerm = document.getElementById('search-empresas')?.value.toLowerCase() || '';
        
        // Recarregar lista com filtros
        await this.loadList();
    }

    static async showForm(id = null) {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const empresasList = document.getElementById('empresas-list');
        const empresasForm = document.getElementById('empresas-form');
        
        if (!empresasList || !empresasForm) return;
        
        empresasList.classList.add('hidden');
        empresasForm.classList.remove('hidden');
        
        const title = document.getElementById('form-empresa-title');
        if (title) {
            title.textContent = id ? 'Editar Empresa' : 'Nova Empresa';
        }
        
        this.clearForm();
        
        if (id) {
            STATE.editMode = true;
            STATE.currentEditId = id;
            await this.loadFormData(id);
        } else {
            STATE.editMode = false;
            STATE.currentEditId = null;
            // Exibir mensagem de nenhuma empresa para nova empresa
            this.displayProprietarios([]);
        }
    }

    static showList() {
        // Verificar se elementos existem (podem não existir em outras páginas)
        const empresasList = document.getElementById('empresas-list');
        const empresasForm = document.getElementById('empresas-form');
        
        if (!empresasList || !empresasForm) return;
        
        empresasList.classList.remove('hidden');
        empresasForm.classList.add('hidden');
        this.loadList();
    }

    static clearForm() {
        const form = document.getElementById('form-empresa');
        if (form) {
            form.reset();
        }
    }

    static async loadFormData(id) {
        const empresa = await storage.getEmpresa(id);
        console.log('Empresa carregada para edição:', empresa);
        if (!empresa) return;
        
        document.getElementById('empresa-id').value = empresa.id;
        // Support both frontend naming (razaoSocial, nomeFantasia) and backend naming (corporate_name, trading_name)
        document.getElementById('empresa-razao-social').value = empresa.razaoSocial || empresa.corporate_name || '';
        document.getElementById('empresa-nome-fantasia').value = empresa.nomeFantasia || empresa.trading_name || '';
        document.getElementById('empresa-cnpj').value = empresa.cnpj || '';
        
        // Carregar proprietários da empresa (do campo 'owners' retornado pela API)
        this.displayProprietarios(empresa.owners || []);
        
        // Carregar grupos vinculados à empresa (suporta array groups ou group_id único)
        const grupos = empresa.groups || [];
        console.log('Grupos da empresa:', grupos);
        
        if (grupos && grupos.length > 0) {
            // Atualizar variável global
            window.gruposSelecionadosAtual = grupos;
            // Atualizar campo hidden com IDs (formato CSV)
            const grupoIds = grupos.map(g => g.id);
            document.getElementById('empresa-grupo-id').value = grupoIds.join(',');
            
            // Atualizar o display
            if (typeof atualizarDisplayGrupo === 'function') {
                console.log('Chamando atualizarDisplayGrupo');
                atualizarDisplayGrupo();
            }
        } else {
            window.gruposSelecionadosAtual = [];
            document.getElementById('empresa-grupo-id').value = '';
        }
    }
    
    static displayProprietarios(owners) {
        const container = document.getElementById('proprietarios-list');
        if (!container) return;
        
        if (!owners || owners.length === 0) {
            container.innerHTML = `
                <div class="no-proprietarios">
                    <i class="fas fa-users"></i>
                    <p>Nenhum proprietário vinculado</p>
                    <small>As pessoas são vinculadas automaticamente quando selecionam esta
                        empresa no cadastro</small>
                </div>
            `;
            return;
        }
        
        // Exibir lista de proprietários com clique para editar via URL
        container.innerHTML = `
            <div class="proprietarios-grid">
                ${owners.map(owner => `
                    <div class="proprietario-card" onclick="window.location.href='/pages/cadastros/pessoas.html?id=${owner.id}'" style="cursor:pointer;">
                        <div class="proprietario-info">
                            <i class="fas fa-user"></i>
                            <div>
                                <strong>${owner.name || 'Nome não informado'}</strong>
                                <small>${owner.cpf ? 'CPF: ' + owner.cpf : ''}</small>
                                <small>${owner.email ? owner.email : ''}</small>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    static loadProprietariosSelect() {
        const select = document.getElementById('empresa-proprietarios');
        if (!select) return;
        
        const pessoas = storage.get('pessoas') || [];
        let options = '';
        
        pessoas.forEach(pessoa => {
            const nome = pessoa.nome || pessoa.name || pessoa.full_name || 'Pessoa';
            const matricula = pessoa.matricula || pessoa.registration_number || pessoa.registrationNumber || '';
            options += `<option value="${pessoa.id}">${nome} (${matricula})</option>`;
        });
        
        select.innerHTML = options;
    }

    static async save(event) {
        event.preventDefault();
        
        // Validar CNPJ
        const cnpj = document.getElementById('empresa-cnpj').value;
        if (cnpj && !InputMask.validateCNPJ(cnpj)) {
            NotificationSystem.showToast('error', 'CNPJ Inválido', 'Por favor, insira um CNPJ válido.');
            return;
        }
        
        // Os proprietários agora são vinculados automaticamente quando uma pessoa
        // seleciona esta empresa no cadastro de pessoa
        // Buscar grupos do campo hidden (agora suporta múltiplos, separados por vírgula)
        const grupoIdInput = document.getElementById('empresa-grupo-id');
        console.log('Campo grupoIdInput:', grupoIdInput);
        console.log('Valor do campo grupoIdInput:', grupoIdInput ? grupoIdInput.value : 'não encontrado');
        
        // Converter string CSV para array de números
        let groupIds = [];
        if (grupoIdInput && grupoIdInput.value) {
            const idsStr = grupoIdInput.value.split(',');
            groupIds = idsStr.map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        }
        console.log('Group IDs antes de salvar:', groupIds);
        
        const empresa = {
            id: STATE.editMode ? parseInt(document.getElementById('empresa-id').value) : null,
            razaoSocial: document.getElementById('empresa-razao-social').value,
            nomeFantasia: document.getElementById('empresa-nome-fantasia').value,
            cnpj: cnpj,
            groupIds: groupIds,
            dataCriacao: STATE.editMode ? (await storage.getEmpresa(STATE.currentEditId)).dataCriacao : new Date().toISOString()
        };
        
        try {
            const savedEmpresa = await storage.saveEmpresa(empresa);
            
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Empresa Atualizada' : 'Empresa Cadastrada',
                `Empresa "${savedEmpresa.razaoSocial}" foi ${STATE.editMode ? 'atualizada' : 'cadastrada'} com sucesso!`
            );
            
            this.showList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao salvar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar a empresa. Tente novamente.');
        }
    }

    static edit(id) {
        this.showForm(id);
    }

    static async confirmDelete(id) {
        const empresa = await storage.getEmpresa(id);
        if (!empresa) return;

        const displayName = empresa.razaoSocial || empresa.corporate_name || empresa.nomeFantasia || empresa.trading_name || 'empresa';
        const isActive = empresa.active !== false;
        
        if (isActive) {
            // Empresa ativa - oferece opção de inativar
            UIManager.showModal(
                'Inativar Empresa',
                `Tem certeza que deseja inativar "${displayName}"? A empresa não aparecerá mais nas listas ativas, mas poderá ser reativada posteriormente.`,
                () => this.delete(id)
            );
        } else {
            // Empresa inativa - oferece reativar ou excluir permanentemente
            const html = `
                <div style="text-align: center;">
                    <p>A empresa "${displayName}" está inativada.</p>
                    <p>Escolha uma ação:</p>
                    <div style="display: flex; gap: 10px; justify-content: center; margin-top: 15px;">
                        <button class="btn btn-success" onclick="EmpresaManager.restore(${id})">
                            <i class="fas fa-check"></i> Reativar
                        </button>
                        <button class="btn btn-danger" onclick="EmpresaManager.hardDelete(${id})">
                            <i class="fas fa-trash"></i> Excluir Permanentemente
                        </button>
                    </div>
                </div>
            `;
            UIManager.showModal('Empresa Inativada', html, null, true);
        }
    }

    static async delete(id) {
        try {
            await storage.deleteEmpresa(id);
            NotificationSystem.showToast('success', 'Empresa Inativada', 'Empresa inativada com sucesso. Você pode reativá-la posteriormente.');
            this.loadList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao inativar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível inativar a empresa.');
        }
    }

    static async restore(id) {
        try {
            await storage.restoreEmpresa(id);
            NotificationSystem.showToast('success', 'Empresa Reativada', 'Empresa reativada com sucesso.');
            this.loadList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao reativar empresa:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível reativar a empresa.');
        }
    }

    static async hardDelete(id) {
        try {
            await api.request(`/companies/${id}?hard=true`, { method: 'DELETE' });
            NotificationSystem.showToast('success', 'Empresa Excluída', 'Empresa excluída permanentemente.');
            this.loadList();
            DashboardManager.load();
            UIManager.updateBadges();
        } catch (error) {
            console.error('Erro ao excluir empresa:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível excluir a empresa.');
        }
    }

    static selectAllProprietarios() {
        const select = document.getElementById('empresa-proprietarios');
        if (select) {
            Array.from(select.options).forEach(option => {
                option.selected = true;
            });
        }
    }

    static clearProprietarios() {
        const select = document.getElementById('empresa-proprietarios');
        if (select) {
            Array.from(select.options).forEach(option => {
                option.selected = false;
            });
        }
    }
}

// ============================================
// GERENCIADOR LGPD (LEI GERAL DE PROTEÇÃO DE DADOS)
// ============================================

class LGPDManager {
    // Exportar todos os dados do usuário logado em CSV
    static exportMyData() {
        try {
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const tenant = localStorage.getItem('tenant') || 'unknown';
            
            // Coletar todos os dados relacionados ao usuário
            const allData = {
                exportDate: new Date().toLocaleString('pt-BR'),
                user: user,
                tenant: tenant,
                data: {
                    pessoas: storage.get('pessoas') || [],
                    visitantes: storage.get('visitantes') || [],
                    grupos: storage.get('grupos') || [],
                    empresas: storage.get('empresas') || [],
                    estacionamentos: storage.get('estacionamentos') || [],
                    operadores: storage.get('operadores') || []
                }
            };
            
            // Criar arquivo JSON
            const dataStr = JSON.stringify(allData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `dados-lgpd-${tenant}-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            
            // Registrar no log de acesso
            this.logDataAccess('EXPORT_DATA', 'Exportação de dados solicitada');
            
            NotificationSystem.showToast('success', 'Exportação Realizada', 'Seus dados foram exportados com sucesso.');
        } catch (error) {
            console.error('Erro na exportação de dados:', error);
            NotificationSystem.showToast('error', 'Erro na Exportação', 'Não foi possível exportar seus dados.');
        }
    }

    // Ver histórico de acessos
    static viewAccessLog() {
        try {
            const accessLog = storage.get('accessLog') || [];
            
            if (accessLog.length === 0) {
                NotificationSystem.showToast('info', 'Histórico Vazio', 'Não há histórico de acessos registrado.');
                return;
            }
            
            let logHtml = '<table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;"><thead><tr style="background: var(--primary); color: white;"><th style="padding: 0.5rem; text-align: left; border: 1px solid #ddd;">Data/Hora</th><th style="padding: 0.5rem; text-align: left; border: 1px solid #ddd;">Ação</th><th style="padding: 0.5rem; text-align: left; border: 1px solid #ddd;">Detalhes</th></tr></thead><tbody>';
            
            // Mostrar últimas 100 entradas
            accessLog.slice(-100).reverse().forEach(entry => {
                const date = new Date(entry.timestamp).toLocaleString('pt-BR');
                logHtml += `<tr style="border: 1px solid #ddd;">
                    <td style="padding: 0.5rem; text-align: left;">${date}</td>
                    <td style="padding: 0.5rem; text-align: left;">${entry.action || 'N/A'}</td>
                    <td style="padding: 0.5rem; text-align: left;">${entry.details || 'N/A'}</td>
                </tr>`;
            });
            
            logHtml += '</tbody></table>';
            
            const modal = document.createElement('div');
            modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2000;';
            modal.innerHTML = `
                <div style="background: white; padding: 2rem; border-radius: 8px; max-width: 900px; max-height: 80vh; overflow: auto; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                    <h2>Histórico de Acessos</h2>
                    <p style="color: #666; font-size: 0.9rem; margin-bottom: 1rem;">Últimas 100 ações registradas</p>
                    ${logHtml}
                    <div style="margin-top: 1rem;">
                        <button class="btn btn-primary" onclick="this.closest('div').parentElement.remove()">Fechar</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            this.logDataAccess('VIEW_ACCESS_LOG', 'Visualização do histórico de acessos');
        } catch (error) {
            console.error('Erro ao visualizar histórico:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível visualizar o histórico de acessos.');
        }
    }

    // Solicitar exclusão de dados (soft delete)
    static requestDataDeletion() {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        
        UIManager.showModal(
            'Solicitar Exclusão de Dados',
            `Você está solicitando a exclusão de todos os seus dados pessoais do sistema. Esta ação:\n\n• Marca seus dados como deletados (soft delete)\n• Seus dados não serão mais acessíveis\n• Registro legal será mantido por ${365} dias\n• Você receberá confirmação por e-mail\n\nDeseja continuar?`,
            () => {
                this.executeDataDeletion(user);
            }
        );
    }

    static executeDataDeletion(user) {
        try {
            // Marcar dados como deletados
            const deletionRecord = {
                userId: user.id,
                userName: user.name,
                userEmail: user.email,
                deletionDate: new Date().toISOString(),
                reason: 'Solicitação do usuário - LGPD Direito ao Esquecimento',
                status: 'DELETED'
            };
            
            // Armazenar registro de exclusão (mantém por rastreabilidade)
            const deletionLog = storage.get('deletionLog') || [];
            deletionLog.push(deletionRecord);
            storage.set('deletionLog', deletionLog);
            
            // Registrar ação
            this.logDataAccess('DATA_DELETION_REQUEST', `Exclusão de dados solicitada para ${user.email}`);
            
            // Limpar dados do localStorage
            localStorage.removeItem('user');
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            
            NotificationSystem.showToast('success', 'Exclusão Solicitada', 'Seus dados foram marcados para exclusão. Você será desconectado.');
            
            // Redirecionar para login após 2 segundos
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 2000);
        } catch (error) {
            console.error('Erro na exclusão de dados:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível processar a exclusão de dados.');
        }
    }

    // Registrar acesso de dados no log LGPD
    static logDataAccess(action, details) {
        try {
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const tenant = localStorage.getItem('tenant') || 'unknown';
            
            const accessEntry = {
                timestamp: new Date().toISOString(),
                action: action,
                details: details,
                userId: user.id,
                userEmail: user.email,
                tenant: tenant,
                ipAddress: 'N/A' // Em produção, obter do backend
            };
            
            const accessLog = storage.get('accessLog') || [];
            accessLog.push(accessEntry);
            
            // Manter apenas últimos 1000 registros
            if (accessLog.length > 1000) {
                accessLog.shift();
            }
            
            storage.set('accessLog', accessLog);
        } catch (error) {
            console.warn('Erro ao registrar acesso LGPD:', error);
        }
    }

    // Gerar relatório de conformidade LGPD
    static generateComplianceReport() {
        try {
            const report = {
                generatedAt: new Date().toISOString(),
                complianceStatus: 'COMPLIANT',
                checks: [
                    {
                        name: 'Consentimento do Titular',
                        status: 'OK',
                        description: 'Consentimento registrado para coleta de dados'
                    },
                    {
                        name: 'Minimização de Dados',
                        status: 'OK',
                        description: 'Apenas dados necessários são coletados'
                    },
                    {
                        name: 'Segurança Técnica',
                        status: 'OK',
                        description: 'Dados armazenados com proteção apropriada'
                    },
                    {
                        name: 'Direito de Acesso',
                        status: 'OK',
                        description: 'Usuários podem exportar seus dados a qualquer momento'
                    },
                    {
                        name: 'Direito ao Esquecimento',
                        status: 'OK',
                        description: 'Solicitações de exclusão são processadas'
                    },
                    {
                        name: 'Transparência',
                        status: 'OK',
                        description: 'Política de privacidade clara e acessível'
                    }
                ],
                dataCategories: [
                    'Dados de Identificação (Nome, CPF, RG)',
                    'Dados de Contato (Email, Telefone)',
                    'Dados Profissionais (Cargo, Empresa)',
                    'Dados de Localização (Endereço)',
                    'Dados Biométricos (Fotografias)',
                    'Dados de Acesso (Logs de entrada/saída)'
                ]
            };
            
            const reportStr = JSON.stringify(report, null, 2);
            const blob = new Blob([reportStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `lgpd-compliance-report-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            
            NotificationSystem.showToast('success', 'Relatório Gerado', 'Relatório de conformidade LGPD exportado com sucesso.');
        } catch (error) {
            console.error('Erro ao gerar relatório:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível gerar o relatório.');
        }
    }
}

// ============================================
// GERENCIADOR DE OPERADORES
// ============================================

class OperadorManager {
    static async loadList() {
        try {
            const operadores = await api.getUsers();
            const tableBody = document.getElementById('operadores-table-body');
            if (!tableBody) return;
            
            if (operadores.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center">Nenhum operador cadastrado</td></tr>';
                return;
            }
            
            tableBody.innerHTML = operadores.map(operador => {
                const roleLabels = {
                    'admin': 'Administrador',
                    'operator': 'Operador',
                    'viewer': 'Visualizador'
                };
                
                return `
                    <tr>
                        <td>${operador.name || ''}</td>
                        <td>${operador.email || ''}</td>
                        <td>${roleLabels[operador.role] || operador.role}</td>
                        <td>
                            <span class="badge ${operador.active ? 'badge-success' : 'badge-danger'}">
                                ${operador.active ? 'Ativo' : 'Inativo'}
                            </span>
                        </td>
                        <td>
                            <div class="action-buttons">
                                <button class="btn-icon btn-edit" onclick="OperadorManager.edit(${operador.id})" title="Editar">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn-icon btn-delete" onclick="OperadorManager.confirmDelete(${operador.id})" title="Excluir">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error('Erro ao carregar operadores:', error);
            const tableBody = document.getElementById('operadores-table-body');
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center text-error">Erro ao carregar operadores</td></tr>';
            }
        }
    }

    static showForm(id = null) {
        const modal = document.getElementById('operador-modal');
        const form = document.getElementById('form-operador');
        const title = document.getElementById('operador-modal-title');
        const senhaInput = document.getElementById('operador-senha');
        const senhaLabel = document.getElementById('operador-senha-label');
        const senhaHint = document.getElementById('operador-senha-hint');
        
        if (!modal || !form) return;
        
        STATE.editMode = !!id;
        STATE.currentEditId = id;
        
        if (id) {
            title.textContent = 'Editar Operador';
            senhaInput.required = false;
            senhaLabel.classList.remove('required');
            senhaHint.style.display = 'block';
            this.loadFormData(id);
        } else {
            title.textContent = 'Novo Operador';
            senhaInput.required = true;
            senhaLabel.classList.add('required');
            senhaHint.style.display = 'none';
            form.reset();
            document.getElementById('operador-id').value = '';
        }
        
        modal.classList.remove('hidden');
    }

    static async loadFormData(id) {
        try {
            const operador = await api.getUser(id);
            if (!operador) return;
            
            document.getElementById('operador-id').value = operador.id || '';
            document.getElementById('operador-nome').value = operador.name || '';
            document.getElementById('operador-email').value = operador.email || '';
            document.getElementById('operador-role').value = operador.role || 'viewer';
            document.getElementById('operador-senha').value = '';
            
            // Carregar permissões
            const permissions = operador.permissions || {};
            Object.keys(permissions).forEach(module => {
                Object.keys(permissions[module]).forEach(action => {
                    const checkbox = document.getElementById(`perm-${module}-${action}`);
                    if (checkbox) {
                        checkbox.checked = permissions[module][action] === true;
                    }
                });
            });
        } catch (error) {
            console.error('Erro ao carregar operador:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível carregar os dados do operador.');
        }
    }

    static async save(event) {
        event.preventDefault();
        
        const operador = {
            id: STATE.editMode ? parseInt(document.getElementById('operador-id').value) : null,
            name: document.getElementById('operador-nome').value,
            email: document.getElementById('operador-email').value,
            password: document.getElementById('operador-senha').value || undefined,
            role: document.getElementById('operador-role').value
        };
        
        // Coletar permissões
        const permissions = {};
        const permissionCheckboxes = document.querySelectorAll('[id^="perm-"]');
        permissionCheckboxes.forEach(checkbox => {
            const idParts = checkbox.id.split('-');
            if (idParts.length >= 3) {
                const module = idParts[1];
                const action = idParts[2];
                if (!permissions[module]) {
                    permissions[module] = {};
                }
                permissions[module][action] = checkbox.checked;
            }
        });
        operador.permissions = permissions;
        
        try {
            let savedOperador;
            if (operador.id) {
                savedOperador = await api.updateUser(operador.id, operador);
            } else {
                if (!operador.password) {
                    NotificationSystem.showToast('error', 'Erro', 'Senha é obrigatória para novos operadores.');
                    return;
                }
                savedOperador = await api.createUser(operador);
            }
            
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Operador Atualizado' : 'Operador Criado',
                `Operador "${savedOperador.name}" foi ${STATE.editMode ? 'atualizado' : 'criado'} com sucesso!`
            );
            
            this.closeForm();
            this.loadList();
        } catch (error) {
            console.error('Erro ao salvar operador:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível salvar o operador.');
        }
    }

    static closeForm() {
        const modal = document.getElementById('operador-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
        STATE.editMode = false;
        STATE.currentEditId = null;
    }

    static edit(id) {
        this.showForm(id);
    }

    static confirmDelete(id) {
        UIManager.showModal(
            'Confirmar Exclusão',
            'Tem certeza que deseja excluir este operador? Esta ação não pode ser desfeita.',
            () => this.delete(id)
        );
    }

    static async delete(id) {
        try {
            await api.deleteUser(id);
            NotificationSystem.showToast('success', 'Operador Excluído', 'Operador excluído com sucesso.');
            this.loadList();
        } catch (error) {
            console.error('Erro ao excluir operador:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível excluir o operador.');
        }
    }
}

// ============================================
// GERENCIADOR DE DASHBOARD
// ============================================

class DashboardManager {
    static load() {
        // Obter estatísticas do localStorage como backup
        const stats = storage.getStats();
        
        // Atualizar estatísticas com verificação null
        const statPessoas = document.getElementById('stat-pessoas');
        const statVisitantes = document.getElementById('stat-visitantes');
        const statGrupos = document.getElementById('stat-grupos');
        const statEmpresas = document.getElementById('stat-empresas');
        
        if (statPessoas) statPessoas.textContent = stats.pessoas;
        if (statVisitantes) statVisitantes.textContent = stats.visitantes;
        if (statGrupos) statGrupos.textContent = stats.grupos;
        if (statEmpresas) statEmpresas.textContent = stats.empresas;
        
        // Atualizar badges
        UIManager.updateBadges();
    }

    static refresh() {
        this.load();
        NotificationSystem.showToast('success', 'Dashboard Atualizado', 'As estatísticas foram atualizadas.');
    }
}

// ============================================
// GERENCIADOR DE CONFIGURAÇÕES
// ============================================

class ConfigManager {
    static load() {
        const labels = storage.get('labels') || CONFIG.DEFAULT_LABELS;
        
        // Carregar valores nos inputs se existirem
        const pessoasInput = document.getElementById('config-label-pessoas');
        const gruposInput = document.getElementById('config-label-grupos');
        
        if (pessoasInput) {
            pessoasInput.value = labels.pessoas;
        }
        if (gruposInput) {
            gruposInput.value = labels.grupos;
        }
        
        // Atualizar labels em toda a interface
        storage.updateLabels();
        
        // Carregar estatísticas
        DashboardManager.load();
        
        // Carregar operadores
        OperadorManager.loadList();

        // Carregar limites de cadastro
        this.loadLimits();
    }

    static async loadLimits() {
        try {
            // Contar pessoas
            const pessoas = await storage.getPessoas();
            const peopleCount = (pessoas || []).length;
            
            // Contar visitantes
            const visitantes = await storage.getVisitantes();
            const visitantesCount = (visitantes || []).length;
            
            // Contar veículos (equipamentos) - são pessoas que têm veiculo
            const veiculosCount = (pessoas || []).filter(p => p.vehicle || p.veiculo).length;

            // Limites padrão (depois podem vir do backend)
            const maxPessoas = 1000;
            const maxEquipamentos = 50;

            // Atualizar números
            document.getElementById('pessoas-count').textContent = peopleCount;
            document.getElementById('pessoas-limit').textContent = maxPessoas;
            document.getElementById('pessoas-available').textContent = Math.max(0, maxPessoas - peopleCount);
            document.getElementById('pessoas-percent').textContent = Math.round((peopleCount / maxPessoas) * 100);

            document.getElementById('equipamentos-count').textContent = veiculosCount;
            document.getElementById('equipamentos-limit').textContent = maxEquipamentos;
            document.getElementById('equipamentos-available').textContent = Math.max(0, maxEquipamentos - veiculosCount);
            document.getElementById('equipamentos-percent').textContent = Math.round((veiculosCount / maxEquipamentos) * 100);

            document.getElementById('visitantes-count').textContent = visitantesCount;

            // Criar gráficos
            this.createPieChart('chartPessoas', peopleCount, maxPessoas - peopleCount, 'Pessoas');
            this.createPieChart('chartEquipamentos', veiculosCount, maxEquipamentos - veiculosCount, 'Equipamentos');

        } catch (error) {
            console.error('Erro ao carregar limites:', error);
        }
    }

    static createPieChart(canvasId, usedValue, availableValue, label) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;

        // Destruir gráfico anterior se existir
        if (window[canvasId + '_chart']) {
            window[canvasId + '_chart'].destroy();
        }

        const totalValue = usedValue + availableValue;
        const usedPercent = totalValue > 0 ? Math.round((usedValue / totalValue) * 100) : 0;

        window[canvasId + '_chart'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [`${label} Utilizados`, 'Disponível'],
                datasets: [{
                    data: [usedValue, availableValue],
                    backgroundColor: [
                        '#dc3545',  // Vermelho para usado
                        '#28a745'   // Verde para disponível
                    ],
                    borderColor: [
                        '#c82333',
                        '#1e7e34'
                    ],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            font: { size: 12 },
                            padding: 15,
                            usePointStyle: true
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const percent = totalValue > 0 ? Math.round((value / totalValue) * 100) : 0;
                                return `${label}: ${value} (${percent}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    static saveLabels() {
        const labelPessoasInput = document.getElementById('config-label-pessoas');
        const labelGruposInput = document.getElementById('config-label-grupos');
        
        if (!labelPessoasInput || !labelGruposInput) {
            NotificationSystem.showToast('error', 'Erro', 'Campos de labels não encontrados.');
            return;
        }
        
        const labelPessoas = labelPessoasInput.value.trim() || CONFIG.DEFAULT_LABELS.pessoas;
        const labelGrupos = labelGruposInput.value.trim() || CONFIG.DEFAULT_LABELS.grupos;
        
        // Salvar labels (isso já chama updateLabels internamente)
        storage.setLabel('pessoas', labelPessoas);
        storage.setLabel('grupos', labelGrupos);
        
        // Atualizar descrições se os elementos existirem
        const pessoasDesc = document.getElementById('label-pessoas-desc');
        if (pessoasDesc) {
            pessoasDesc.textContent = `Cadastre ${labelPessoas.toLowerCase()} para acesso ao sistema`;
        }
        
        const gruposDesc = document.getElementById('label-grupos-desc');
        if (gruposDesc) {
            gruposDesc.textContent = `Organize ${labelPessoas.toLowerCase()} em ${labelGrupos.toLowerCase()} como Blocos, Salas, etc.`;
        }
        
        // Forçar atualização novamente para garantir que todos os elementos sejam atualizados
        setTimeout(() => {
            storage.updateLabels();
        }, 100);
        
        NotificationSystem.showToast('success', 'Labels Atualizados', `As labels foram atualizadas: "${labelPessoas}" e "${labelGrupos}" serão usadas em todo o sistema.`);
    }

    static backupData() {
        try {
            storage.backupData();
            NotificationSystem.showToast('success', 'Backup Realizado', 'Backup dos dados realizado com sucesso.');
        } catch (error) {
            NotificationSystem.showToast('error', 'Erro no Backup', 'Não foi possível realizar o backup.');
            console.error('Erro no backup:', error);
        }
    }

    static restoreData() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            
            try {
                await storage.restoreData(file);
                NotificationSystem.showToast('success', 'Dados Restaurados', 'Os dados foram restaurados com sucesso.');
                
                // Recarregar toda a aplicação
                location.reload();
            } catch (error) {
                NotificationSystem.showToast('error', 'Erro na Restauração', 'Não foi possível restaurar os dados.');
                console.error('Erro na restauração:', error);
            }
        };
        
        input.click();
    }

    static clearData() {
        UIManager.showModal(
            'Limpar Todos os Dados',
            'Tem certeza que deseja limpar TODOS os dados do sistema? Esta ação não pode ser desfeita e todos os registros serão perdidos.',
            () => {
                storage.clear();
                NotificationSystem.showToast('success', 'Dados Limpos', 'Todos os dados foram removidos.');
                location.reload();
            }
        );
    }

    static showPrivacyPolicy() {
        const policy = `
            <h3>Política de Privacidade - MAM Control</h3>
            <p><strong>Última atualização:</strong> ${new Date().toLocaleDateString('pt-BR')}</p>
            
            <h4>1. Coleta de Dados</h4>
            <p>Este sistema coleta apenas os dados necessários para o funcionamento do controle de acesso, incluindo:</p>
            <ul>
                <li>Dados pessoais (nome, CPF, RG, etc.)</li>
                <li>Dados de contato (telefone, e-mail)</li>
                <li>Informações profissionais (cargo, empresa)</li>
                <li>Fotografias para identificação</li>
                <li>Dados de veículos (para controle de acesso)</li>
            </ul>
            
            <h4>2. Armazenamento</h4>
            <p>Todos os dados são armazenados localmente no seu navegador, utilizando o localStorage. Nenhum dado é enviado para servidores externos.</p>
            
            <h4>3. Finalidade</h4>
            <p>Os dados coletados são utilizados exclusivamente para:</p>
            <ul>
                <li>Controle de acesso de pessoas e visitantes</li>
                <li>Identificação de indivíduos</li>
                <li>Geração de relatórios e estatísticas</li>
                <li>Melhoria da segurança do local</li>
            </ul>
            
            <h4>4. Compartilhamento</h4>
            <p>Nenhum dado é compartilhado com terceiros. Todos os dados permanecem no dispositivo do usuário.</p>
            
            <h4>5. Direitos do Titular</h4>
            <p>De acordo com a LGPD, você tem direito a:</p>
            <ul>
                <li>Acessar seus dados</li>
                <li>Corrigir dados incorretos</li>
                <li>Excluir seus dados</li>
                <li>Revogar consentimento</li>
                <li>Exportar seus dados</li>
            </ul>
            
            <h4>6. Segurança</h4>
            <p>Implementamos medidas de segurança para proteger seus dados, incluindo:</p>
            <ul>
                <li>Armazenamento local seguro</li>
                <li>Controle de acesso por senha (se implementado)</li>
                <li>Backup regular dos dados</li>
            </ul>
            
            <h4>7. Contato</h4>
            <p>Para exercer seus direitos ou tirar dúvidas sobre privacidade, entre em contato com o administrador do sistema.</p>
        `;
        
        UIManager.showModal('Política de Privacidade', policy, () => {});
    }
}

// ============================================
// GERENCIADOR DE RELATÓRIOS
// ============================================

class ReportManager {
    static generateReport(type) {
        switch (type) {
            case 'pessoas':
                this.generatePessoasReport();
                break;
            case 'visitantes':
                this.generateVisitantesReport();
                break;
        }
    }

    static generatePessoasReport() {
        const pessoas = storage.get('pessoas') || [];
        const grupos = storage.get('grupos') || [];
        
        if (pessoas.length === 0) {
            NotificationSystem.showToast('warning', 'Sem Dados', 'Não há pessoas cadastradas para gerar relatório.');
            return;
        }
        
        let report = `
            RELATÓRIO DE PESSOAS
            =====================
            Data: ${new Date().toLocaleDateString('pt-BR')}
            Total: ${pessoas.length} pessoa(s)
            
        `;
        
        // Agrupar por grupo
        const gruposMap = {};
        grupos.forEach(grupo => {
            gruposMap[grupo.id] = {
                nome: grupo.nome || grupo.name,
                pessoas: []
            };
        });
        
        // Pessoa sem grupo
        gruposMap['sem_grupo'] = {
            nome: 'Sem Grupo',
            pessoas: []
        };
        
        pessoas.forEach(pessoa => {
            const grupoId = pessoa.grupoId || pessoa.group_id || pessoa.groupId;
            const grupo = grupoId ? gruposMap[grupoId] : gruposMap['sem_grupo'];
            if (grupo) {
                grupo.pessoas.push(pessoa);
            }
        });
        
        // Adicionar ao relatório
        Object.values(gruposMap).forEach(grupo => {
            if (grupo.pessoas.length > 0) {
                report += `\n${grupo.nome.toUpperCase()} (${grupo.pessoas.length})\n`;
                report += '-'.repeat(50) + '\n';
                
                grupo.pessoas.forEach(pessoa => {
                    const nome = pessoa.nome || pessoa.name || 'Pessoa';
                    const matricula = pessoa.matricula || pessoa.registration_number || pessoa.registrationNumber || 'N/A';
                    const cpf = pessoa.cpf || '';
                    const email = pessoa.email || 'Sem e-mail';
                    report += `• ${nome} | ${matricula} | ${Formatter.formatCPF(cpf)} | ${email}\n`;
                });
            }
        });
        
        this.downloadReport(report, 'relatorio-pessoas.txt');
    }

    static generateVisitantesReport() {
        const visitantes = storage.get('visitantes') || [];
        
        if (visitantes.length === 0) {
            NotificationSystem.showToast('warning', 'Sem Dados', 'Não há visitantes registrados para gerar relatório.');
            return;
        }
        
        // Filtrar por data (últimos 30 dias por padrão)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentes = visitantes.filter(v => new Date(v.dataEntrada) >= thirtyDaysAgo);
        
        let report = `
            RELATÓRIO DE VISITANTES (ÚLTIMOS 30 DIAS)
            ===========================================
            Data: ${new Date().toLocaleDateString('pt-BR')}
            Período: ${thirtyDaysAgo.toLocaleDateString('pt-BR')} a ${new Date().toLocaleDateString('pt-BR')}
            Total: ${recentes.length} visitante(s)
            
        `;
        
        // Agrupar por data
        const porData = {};
        recentes.forEach(visitante => {
            const data = new Date(visitante.dataEntrada).toLocaleDateString('pt-BR');
            if (!porData[data]) {
                porData[data] = [];
            }
            porData[data].push(visitante);
        });
        
        // Ordenar datas
        const datasOrdenadas = Object.keys(porData).sort((a, b) => new Date(b) - new Date(a));
        
        datasOrdenadas.forEach(data => {
            report += `\n${data} (${porData[data].length})\n`;
            report += '-'.repeat(50) + '\n';
            
            porData[data].forEach(visitante => {
                const entrada = Formatter.formatDateTime(visitante.entry_date || visitante.dataEntrada);
                const saida = (visitante.exit_date || visitante.dataSaida) ? Formatter.formatDateTime(visitante.exit_date || visitante.dataSaida) : 'Ainda no local';
                report += `• ${visitante.nome} | CPF: ${Formatter.formatCPF(visitante.documento)} | Entrada: ${entrada} | Saída: ${saida}\n`;
                report += `  Motivo: ${visitante.motivo || 'Não informado'}\n`;
                report += `  Empresa: ${visitante.empresa || 'Não informada'}\n\n`;
            });
        });
        
        this.downloadReport(report, 'relatorio-visitantes.txt');
    }

    static downloadReport(content, filename) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        NotificationSystem.showToast('success', 'Relatório Gerado', 'O relatório foi baixado com sucesso.');
    }

    static async showStatistics() {
        const stats = storage.getStats();
        const pessoas = storage.get('pessoas') || [];
        const visitantes = storage.get('visitantes') || [];

        // Pré-carregar grupos e empresas
        const gruposResponse = await storage.getGrupos();
        const gruposList = gruposResponse?.data || (Array.isArray(gruposResponse) ? gruposResponse : []);
        const gruposMap = new Map((gruposList || []).map(g => [g.id, g]));
        // Carregar TODAS as empresas (ativas e inativas)
        const empresasList = await api.getCompanies(undefined);
        const empresasMap = new Map((empresasList || []).map(e => [e.id, e]));

        // Calcular estatísticas básicas
        const pessoasPorGrupo = {};
        const pessoasPorEmpresa = {};
        const visitantesPorMes = {};

        pessoas.forEach(pessoa => {
            // Por grupo
            if (pessoa.grupoId) {
                const grupo = gruposMap.get(parseInt(pessoa.grupoId)) || gruposMap.get(pessoa.grupoId);
                if (grupo) {
                    const nome = grupo.name || grupo.nome;
                    pessoasPorGrupo[nome] = (pessoasPorGrupo[nome] || 0) + 1;
                }
            }

            // Por empresa
            if (pessoa.empresaId) {
                const empresa = empresasMap.get(parseInt(pessoa.empresaId)) || empresasMap.get(pessoa.empresaId);
                if (empresa) {
                    const nome = empresa.corporate_name || empresa.razaoSocial;
                    pessoasPorEmpresa[nome] = (pessoasPorEmpresa[nome] || 0) + 1;
                }
            }
        });
        
        // Visitantes por mês
        visitantes.forEach(visitante => {
            const date = new Date(visitante.dataEntrada);
            const mesAno = `${date.getMonth() + 1}/${date.getFullYear()}`;
            visitantesPorMes[mesAno] = (visitantesPorMes[mesAno] || 0) + 1;
        });
        
        let statsReport = `
            ESTATÍSTICAS DO SISTEMA
            ========================
            Data: ${new Date().toLocaleDateString('pt-BR')}
            
            RESUMO GERAL:
            • Pessoas cadastradas: ${stats.pessoas}
            • Visitantes registrados: ${stats.visitantes}
            • Grupos criados: ${stats.grupos}
            • Empresas cadastradas: ${stats.empresas}
            
        `;
        
        if (Object.keys(pessoasPorGrupo).length > 0) {
            statsReport += '\nPESSOAS POR GRUPO:\n';
            statsReport += '-'.repeat(30) + '\n';
            Object.entries(pessoasPorGrupo).forEach(([grupo, count]) => {
                statsReport += `• ${grupo}: ${count} pessoa(s)\n`;
            });
        }
        
        if (Object.keys(visitantesPorMes).length > 0) {
            statsReport += '\nVISITANTES POR MÊS:\n';
            statsReport += '-'.repeat(30) + '\n';
            Object.entries(visitantesPorMes).forEach(([mes, count]) => {
                statsReport += `• ${mes}: ${count} visitante(s)\n`;
            });
        }
        
        this.downloadReport(statsReport, 'estatisticas-sistema.txt');
    }
}

// ============================================
// FUNÇÕES GLOBAIS PARA HTML
// ============================================

// Navegação
function showSection(sectionId) {
    UIManager.showSection(sectionId);
}

function toggleSidebar() {
    UIManager.toggleSidebar();
}

// Pessoas
function showPessoaForm(id = null) {
    PessoaManager.showForm(id);
}

function showPessoasList() {
    PessoaManager.showList();
}

function generateMatricula() {
    PessoaManager.generateMatricula();
}

function filterPessoas() {
    PessoaManager.filter();
}

function refreshPessoas() {
    PessoaManager.loadList();
    NotificationSystem.showToast('success', 'Lista Atualizada', 'Lista de pessoas atualizada.');
}

// Visitantes
function showVisitanteForm(id = null) {
    // Esta função agora é definida no lista.html
    // Chamando a função global se disponível
    if (typeof window.showVisitanteFormActual !== 'undefined') {
        window.showVisitanteFormActual(id);
    } else {
        // Fallback: mostra o formulário
        document.getElementById('visitantes-list').classList.add('hidden');
        document.getElementById('visitantes-form').classList.remove('hidden');
    }
}

function showVisitantesList() {
    VisitanteManager.showList();
}

function filterVisitantes() {
    VisitanteManager.filter();
}

function refreshVisitantes() {
    VisitanteManager.loadList();
    NotificationSystem.showToast('success', 'Lista Atualizada', 'Lista de visitantes atualizada.');
}

// Grupos
function showGrupoForm(id = null) {
    GrupoManager.showForm(id);
}

function showGruposList() {
    GrupoManager.showList();
}

function filterGrupos() {
    GrupoManager.filter();
}

function refreshGrupos() {
    GrupoManager.loadList();
    NotificationSystem.showToast('success', 'Lista Atualizada', 'Lista de grupos atualizada.');
}

// Empresas
function showEmpresaForm(id = null) {
    EmpresaManager.showForm(id);
}

function showEmpresasList() {
    EmpresaManager.showList();
}

function filterEmpresas() {
    EmpresaManager.filter();
}

function refreshEmpresas() {
    EmpresaManager.loadList();
    NotificationSystem.showToast('success', 'Lista Atualizada', 'Lista de empresas atualizada.');
}

function selectAllProprietarios() {
    EmpresaManager.selectAllProprietarios();
}

function clearProprietarios() {
    EmpresaManager.clearProprietarios();
}

// Funções globais para formulários
function savePessoa(event) {
    PessoaManager.save(event);
}

function saveVisitante(event) {
    VisitanteManager.save(event);
}

function saveGrupo(event) {
    GrupoManager.save(event);
}

function saveEmpresa(event) {
    EmpresaManager.save(event);
}

// Operadores
function showOperadorForm(id = null) {
    OperadorManager.showForm(id);
}

function closeOperadorModal() {
    OperadorManager.closeForm();
}

function saveOperador(event) {
    OperadorManager.save(event);
}

// Configurações
function showConfigTab(tabName) {
    // Remover classe active de todos os botões e conteúdos
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Adicionar classe active ao botão e conteúdo selecionados
    const btn = document.querySelector(`[data-tab="${tabName}"]`);
    const content = document.getElementById(`config-tab-${tabName}`);
    
    if (btn) btn.classList.add('active');
    if (content) {
        content.classList.add('active');
        
        // Se for a aba de operadores, carregar a lista
        if (tabName === 'operadores') {
            OperadorManager.loadList();
        }
    }
}

function showPreferenciasTab(tabName) {
    // Remover classe active de todos os botões e conteúdos
    const tabsNav = document.querySelector('.tabs-nav');
    if (!tabsNav) return;
    
    tabsNav.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Adicionar classe active ao botão e conteúdo selecionados
    const btn = tabsNav.querySelector(`[data-tab="${tabName}"]`);
    const content = document.getElementById(`preferencias-tab-${tabName}`);
    
    if (btn) btn.classList.add('active');
    if (content) {
        content.classList.add('active');
    }

    // Se abrir a aba "dados", carregar os limites
    if (tabName === 'dados') {
        ConfigManager.loadLimits();
    }
}

function saveLabels() {
    ConfigManager.saveLabels();
}

function backupData() {
    ConfigManager.backupData();
}

function restoreData() {
    ConfigManager.restoreData();
}

function clearData() {
    ConfigManager.clearData();
}

function showPrivacyPolicy() {
    ConfigManager.showPrivacyPolicy();
}

// Dashboard
function refreshDashboard() {
    DashboardManager.refresh();
}

// Relatórios
function generateReport(type) {
    ReportManager.generateReport(type);
}

function showStatistics() {
    ReportManager.showStatistics();
}

// Utilitários
function switchTab(tabName) {
    UIManager.switchFormTab(tabName);
}

function openFilePicker() {
    PessoaManager.openFilePicker();
}

function openCamera() {
    PessoaManager.openCamera();
}

function openVisitanteFilePicker() {
    VisitanteManager.openFilePicker();
}

function openVisitanteCamera() {
    VisitanteManager.openCamera();
}

function handlePhotoUpload(event) {
    PessoaManager.handlePhotoUpload(event);
}

function handleVisitantePhotoUpload(event) {
    VisitanteManager.handlePhotoUpload(event);
}

// Excluir permanentemente visitante (apenas para inativos)
async function forceDeleteVisitor(id) {
    if (!confirm('Deseja realmente excluir PERMANENTEMENTE este visitante? Esta ação não pode ser desfeita.')) {
        return;
    }
    
    try {
        const response = await api.request(`/visitors/${id}/force`, {
            method: 'DELETE'
        });
        
        if (response.success) {
            alert('Visitante excluído permanentemente com sucesso!');
            VisitanteManager.loadList();
        } else {
            alert('Erro ao excluir visitante: ' + (response.message || 'Erro desconhecido'));
        }
    } catch (error) {
        console.error('Erro ao excluir visitante:', error);
        alert('Erro ao excluir visitante');
    }
}

function toggleVagaSelect() {
    const tipoVagaSelect = document.getElementById('veiculo-tipo-vaga');
    const vagaContainer = document.getElementById('veiculo-vaga-container');
    const empresaContainer = document.getElementById('veiculo-empresa-container');
    
    if (!tipoVagaSelect) return;
    
    const tipoVaga = tipoVagaSelect.value;
    
    if (tipoVaga === 'fixa') {
        if (vagaContainer) vagaContainer.style.display = 'block';
        if (empresaContainer) empresaContainer.style.display = 'none';
        loadAvailableSpots();
    } else if (tipoVaga === 'rotativa') {
        if (vagaContainer) vagaContainer.style.display = 'none';
        if (empresaContainer) {
            empresaContainer.style.display = 'block';
            loadEmpresasForVagaRotativa();
        }
    } else {
        if (vagaContainer) vagaContainer.style.display = 'none';
        if (empresaContainer) empresaContainer.style.display = 'none';
    }
}

// Função para alternar campos de vaga no formulário de veículos (cadastro direto)
function toggleVagaVeiculoFields() {
    const tipoVagaSelect = document.getElementById('tipoVaga');
    const vagaFixaContainer = document.getElementById('vaga-fixa-container');
    const vagaRotativaContainer = document.getElementById('vaga-rotativa-container');
    
    if (!tipoVagaSelect) return;
    
    const tipoVaga = tipoVagaSelect.value;
    
    if (tipoVaga === 'fixa') {
        if (vagaFixaContainer) vagaFixaContainer.style.display = 'block';
        if (vagaRotativaContainer) vagaRotativaContainer.style.display = 'none';
        loadVagasForVeiculoForm();
    } else if (tipoVaga === 'rotativa') {
        if (vagaFixaContainer) vagaFixaContainer.style.display = 'none';
        if (vagaRotativaContainer) vagaRotativaContainer.style.display = 'block';
        loadEmpresasForVeiculoForm();
    } else {
        if (vagaFixaContainer) vagaFixaContainer.style.display = 'none';
        if (vagaRotativaContainer) vagaRotativaContainer.style.display = 'none';
    }
}

// Carregar vagas para o formulário de veículos (cadastro direto)
async function loadVagasForVeiculoForm() {
    const select = document.getElementById('veiculo-vaga');
    if (!select) return;
    
    try {
        const response = await api.request('/parkings?limit=10000');
        const estacionamentos = response.success ? response.data : [];
        
        const fixedParkings = estacionamentos.filter(e => e.type === 'fixo' && e.active);
        
        let options = '<option value="">Selecione uma vaga</option>';
        let hasSpots = false;
        
        for (const parking of fixedParkings) {
            if (parking.spots && parking.spots.length > 0) {
                const availableSpots = parking.spots.filter(s => s.status === 'available');
                availableSpots.forEach(spot => {
                    options += `<option value="${spot.id}" data-spot="${spot.spot_number}" data-parking="${parking.id}">${parking.name} - Vaga ${spot.spot_number}</option>`;
                    hasSpots = true;
                });
            }
        }
        
        if (!hasSpots) {
            options = '<option value="">Nenhuma vaga disponível</option>';
        }
        
        select.innerHTML = options;
    } catch (error) {
        console.error('Erro ao carregar vagas:', error);
        select.innerHTML = '<option value="">Erro ao carregar vagas</option>';
    }
}

// Carregar empresas para o formulário de veículos (cadastro direto)
async function loadEmpresasForVeiculoForm() {
    const select = document.getElementById('veiculo-empresa');
    if (!select) return;
    
    try {
        const response = await api.request('/companies?limit=10000');
        const empresas = response.success ? response.data : [];
        
        let options = '<option value="">Selecione uma empresa</option>';
        
        empresas.forEach(empresa => {
            const nome = empresa.trading_name || empresa.corporate_name || empresa.name || 'Empresa ' + empresa.id;
            options += `<option value="${empresa.id}">${nome}</option>`;
        });
        
        if (empresas.length === 0) {
            options = '<option value="">Nenhuma empresa disponível</option>';
        }
        
        select.innerHTML = options;
    } catch (error) {
        console.error('Erro ao carregar empresas:', error);
        select.innerHTML = '<option value="">Erro ao carregar empresas</option>';
    }
}
   

// Função para carregar empresas para vaga rotativa
async function loadEmpresasForVagaRotativa() {
    const select = document.getElementById('veiculo-empresa');
    if (!select) return;
    
    try {
        // Carregar empresas do banco de dados com limite maior
        const result = await api.request('/companies?limit=10000');
        
        if (result.success && result.data && result.data.length > 0) {
            // Salvar no cache global para uso posterior
            window.empresasCache = result.data;
            
            let options = '<option value="">Selecione uma empresa</option>';
            result.data.forEach(empresa => {
                // Backend retorna corporate_name e trading_name
                const nome = empresa.corporate_name || empresa.trading_name || empresa.name || empresa.nome || 'Empresa sem nome';
                options += `<option value="${empresa.id}">${nome}</option>`;
            });
            select.innerHTML = options;
        } else {
            window.empresasCache = [];
            select.innerHTML = '<option value="">Nenhuma empresa cadastrada</option>';
        }
    } catch (error) {
        console.error('Erro ao carregar empresas:', error);
        // Tentar do localStorage como fallback
        const stored = localStorage.getItem('mamcontrol_companies');
        if (stored) {
            const empresas = JSON.parse(stored);
            window.empresasCache = empresas;
            if (empresas.length > 0) {
                let options = '<option value="">Selecione uma empresa</option>';
                empresas.forEach(empresa => {
                    const nome = empresa.corporate_name || empresa.trading_name || empresa.name || empresa.nome || 'Empresa sem nome';
                    options += `<option value="${empresa.id}">${nome}</option>`;
                });
                select.innerHTML = options;
            } else {
                select.innerHTML = '<option value="">Nenhuma empresa cadastrada</option>';
            }
        } else {
            window.empresasCache = [];
            select.innerHTML = '<option value="">Nenhuma empresa cadastrada</option>';
        }
    }
}

async function loadAvailableSpots() {
    const select = document.getElementById('veiculo-vaga');
    console.log('[DEBUG loadAvailableSpots] Select element:', select);
    if (!select) return;
    
    try {
        // Buscar estacionamentos com vagas fixas diretamente da API
        const response = await api.request('/parkings?limit=10000');
        console.log('[DEBUG loadAvailableSpots] API response:', response);
        const estacionamentos = response.success ? response.data : [];
        
        console.log('Estacionamentos carregados para vagas:', estacionamentos);
        
        if (!estacionamentos || estacionamentos.length === 0) {
            select.innerHTML = '<option value="">Nenhum estacionamento disponível</option>';
            return;
        }
        
        const fixedParkings = estacionamentos.filter(e => e.type === 'fixo' && e.active);
        console.log('[DEBUG loadAvailableSpots] Fixed parkings:', fixedParkings);
        
        console.log('Estacionamentos fixos:', fixedParkings);
        
        let options = '<option value="">Selecione uma vaga</option>';
        let hasSpots = false;
        
        for (const parking of fixedParkings) {
            console.log('Estacionamento:', parking.name, 'Spots:', parking.spots);
            if (parking.spots && parking.spots.length > 0) {
                const availableSpots = parking.spots.filter(s => s.status === 'available');
                availableSpots.forEach(spot => {
                    options += `<option value="${spot.id}" data-spot="${spot.spot_number}" data-parking="${parking.id}">${parking.name} - Vaga ${spot.spot_number}</option>`;
                    hasSpots = true;
                });
            }
        }
        
        if (!hasSpots) {
            options = '<option value="">Nenhuma vaga disponível</option>';
        }
        
        select.innerHTML = options;
        console.log('[DEBUG loadAvailableSpots] Options set, hasSpots:', hasSpots);
    } catch (error) {
        console.error('Erro ao carregar vagas disponíveis:', error);
        select.innerHTML = '<option value="">Erro ao carregar vagas</option>';
    }
}

function showAddVeiculoForm() {
    const container = document.getElementById('veiculo-form-container');
    if (container) {
        container.style.display = container.style.display === 'none' ? 'block' : 'none';
    }
}

function addVeiculoToList() {
    const placaInput = document.getElementById('veiculo-placa');
    const marcaInput = document.getElementById('veiculo-marca');
    const modeloInput = document.getElementById('veiculo-modelo');
    const corInput = document.getElementById('veiculo-cor');
    const tipoVagaSelect = document.getElementById('veiculo-tipo-vaga');
    const vagaSelect = document.getElementById('veiculo-vaga');
    const empresaSelect = document.getElementById('veiculo-empresa');
    const tagNumeroInput = document.getElementById('veiculo-tag-numero');
    
    if (!placaInput || !tipoVagaSelect) {
        NotificationSystem.showToast('error', 'Erro', 'Elementos do formulário não encontrados');
        return;
    }
    
    const placa = placaInput.value.trim().toUpperCase();
    const marca = marcaInput ? marcaInput.value.trim() : '';
    const modelo = modeloInput ? modeloInput.value.trim() : '';
    const cor = corInput ? corInput.value.trim() : '';
    const tipoVaga = tipoVagaSelect.value;
    const vaga = vagaSelect ? vagaSelect.value : '';
    const empresa = empresaSelect ? empresaSelect.value : '';
    const tagNumero = tagNumeroInput ? tagNumeroInput.value.trim() : '';
    const tipoTag = document.querySelector('input[name="tipo-tag-veiculo"]:checked')?.value || 'manual';
    
    if (!placa) {
        NotificationSystem.showToast('error', 'Erro', 'A placa é obrigatória');
        return;
    }
    
    // Validar formato da placa (ABC-1234, ABC1234 ou ABC1D23)
    const placaRegex = /^[A-Z]{3}-?\d{4}$|^[A-Z]{3}\d[A-Z]\d{2}$/;
    if (!placaRegex.test(placa)) {
        NotificationSystem.showToast('error', 'Erro', 'Placa inválida! Use o formato ABC-1234, ABC1234 ou ABC1D23');
        return;
    }
    
    // Armazenar dados do veículo temporariamente
    let vagaInfo = '';
    if (tipoVaga === 'fixa' && vagaSelect) {
        const selectedOption = vagaSelect.options[vagaSelect.selectedIndex];
        if (selectedOption && selectedOption.getAttribute) {
            vagaInfo = selectedOption.getAttribute('data-spot') || '';
        }
    } else if (tipoVaga === 'rotativa' && empresaSelect) {
        const selectedOption = empresaSelect.options[empresaSelect.selectedIndex];
        if (selectedOption && selectedOption.value) {
            vagaInfo = 'Rotativa - ' + selectedOption.text;
        } else {
            vagaInfo = 'Rotativa';
        }
    }
    
    const veiculoData = {
        placa,
        marca,
        modelo,
        cor,
        color: cor, // Mapear cor para color para o backend
        tipoVaga,
        vagaId: tipoVaga === 'fixa' ? vaga : null,
        empresaId: tipoVaga === 'rotativa' ? empresa : null,
        vagaInfo: vagaInfo,
        tagNumero: tagNumero || null,
        tagTipo: tipoTag
    };
    
    // Mostrar na tabela de veículos
    const tbody = document.getElementById('veiculos-table-body');
    if (!tbody) {
        NotificationSystem.showToast('error', 'Erro', 'Tabela de veículos não encontrada');
        return;
    }
    
    let html = '';
    
    
    const tagDisplay = tagNumero ? `<span style="background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem;"><i class="fas fa-tag"></i> ${tagNumero}</span>` : '-';
    
    // Criar atributo data para empresa ou vaga (usado na recuperação)
    const dataVagaId = tipoVaga === 'fixa' && vaga ? `data-vaga-id="${vaga}"` : '';
    const dataEmpresaId = tipoVaga === 'rotativa' && empresa ? `data-empresa-id="${empresa}"` : '';
    
    console.log('[DEBUG] Adding vehicle to table - tipoVaga:', tipoVaga, 'vaga:', vaga, 'empresa:', empresa);
    console.log('[DEBUG] Data attributes:', dataVagaId, dataEmpresaId);
    
    html += `
        <tr ${dataVagaId} ${dataEmpresaId}>
            <td>${placa}</td>
            <td>${marca}</td>
            <td>${modelo}</td>
            <td>${cor}</td>
            <td>${tipoVaga === 'fixa' ? '🔧 Fixa' : '🔄 Rotativa'}</td>
            <td>${vagaInfo}</td>
            <td>${tagDisplay}</td>
            <td>
                <button class="btn btn-sm btn-danger" onclick="removeVeiculo(this)">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `;
    
    if (tbody.innerHTML.includes('Nenhum veículo')) {
        tbody.innerHTML = html;
    } else {
        tbody.innerHTML += html;
    }
    
    // Salvar no localStorage de veículos (sincronização com aba de veículos)
    salvarVeiculoNoStorage(veiculoData);
    
    // Limpar formulário
    const formContainer = document.getElementById('veiculo-form-container');
    const vagaContainer = document.getElementById('veiculo-vaga-container');
    const empresaContainer = document.getElementById('veiculo-empresa-container');
    
    if (formContainer) formContainer.style.display = 'none';
    if (placaInput) placaInput.value = '';
    if (marcaInput) marcaInput.value = '';
    if (modeloInput) modeloInput.value = '';
    if (corInput) corInput.value = '';
    if (anoInput) anoInput.value = '';
    if (tipoVagaSelect) tipoVagaSelect.value = '';
    if (tagNumeroInput) tagNumeroInput.value = '';
    if (vagaContainer) vagaContainer.style.display = 'none';
    if (empresaContainer) empresaContainer.style.display = 'none';
    
    // Resetar tipo de tag
    const manualRadio = document.querySelector('input[name="tipo-tag-veiculo"][value="manual"]');
    if (manualRadio) manualRadio.checked = true;
    toggleVeiculoTagFields();
    
    NotificationSystem.showToast('success', 'Veículo Adicionado', 'Veículo adicionado com sucesso');
}

// Função para adicionar veículo à tabela quando editando uma pessoa (sem limpar formulário)
function addVeiculoToTableFromEdit(vehicle) {
    console.log('[DEBUG] addVeiculoToTableFromEdit called with:', vehicle);
    const tbody = document.getElementById('veiculos-table-body');
    if (!tbody) {
        console.log('[DEBUG] Table body not found');
        return;
    }
    
    // Normalizar dados do veículo (pode vir com nomes em inglês ou português)
    const placa = vehicle.placa || vehicle.license_plate || '';
    const marca = vehicle.marca || vehicle.brand || '';
    const modelo = vehicle.modelo || vehicle.model || '';
    const cor = vehicle.cor || vehicle.color || '';
    const ano = vehicle.ano || vehicle.year || '';
    const tagNumero = vehicle.tag_number || vehicle.tagNumero || '';
    
    // Dados de vaga e empresa
    const parkingId = vehicle.parking_id || vehicle.parkingId || null;
    const companyId = vehicle.company_id || vehicle.companyId || null;
    const spotNumber = vehicle.spot_number || vehicle.spotNumber || null;
    
    if (!placa) return;
    
    // Verificar se veículo já está na tabela
    if (tbody.innerHTML.includes(placa)) return;
    
    // Determinar tipo de vaga e informações de vaga/empresa
    let tipoVagaDisplay = '-';
    let vagaInfo = '-';
    let tagDisplay = '-';
    
    if (spotNumber) {
        tipoVagaDisplay = '🔧 Fixa';
        vagaInfo = spotNumber;
    } else if (companyId) {
        tipoVagaDisplay = '🔄 Rotativa';
        // Usar o nome da empresa fornecido pelo backend se disponível
        const companyDisplayName = vehicle.company_display_name || vehicle.companyName || vehicle.company_name;
        if (companyDisplayName) {
            vagaInfo = companyDisplayName;
        } else {
            // Se não tem nome do backend, tentar buscar do cache
            if (!window.empresasCache || window.empresasCache.length === 0) {
                loadEmpresasForVagaRotativa();
            }
            const empresaNome = getEmpresaNome(companyId);
            vagaInfo = empresaNome || 'Empresa #' + companyId;
        }
    }
    
    if (tagNumero) {
        tagDisplay = `<span style="background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem;"><i class="fas fa-tag"></i> ${tagNumero}</span>`;
    }
    
    const html = `
        <tr ${parkingId ? `data-parking-id="${parkingId}"` : ''} ${companyId ? `data-company-id="${companyId}"` : ''}>
            <td>${placa}</td>
            <td>${marca}</td>
            <td>${modelo}</td>
            <td>${cor}</td>
            <td>${tipoVagaDisplay}</td>
            <td>${vagaInfo}</td>
            <td>${tagDisplay}</td>
            <td>
                <button class="btn btn-sm btn-danger" onclick="removeVeiculo(this)">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `;
    
    if (tbody.innerHTML.includes('Nenhum veículo')) {
        tbody.innerHTML = html;
    } else {
        tbody.innerHTML += html;
    }
}

// Função auxiliar para buscar nome da empresa pelo ID
function getEmpresaNome(companyId) {
    const empresaSelect = document.getElementById('veiculo-empresa');
    if (empresaSelect && empresaSelect.options) {
        for (const option of empresaSelect.options) {
            if (option.value === String(companyId)) {
                return option.text;
            }
        }
    }
    // Se não encontrou no select, tentar usar o cache de empresas global
    if (window.empresasCache) {
        const empresa = window.empresasCache.find(e => e.id === parseInt(companyId) || e.id === String(companyId));
        if (empresa) {
            return empresa.corporate_name || empresa.trading_name || empresa.name || 'Empresa ' + empresa.id;
        }
    }
    return null;
}

// Função para salvar veículo no localStorage (sincronização com aba de veículos)
function salvarVeiculoNoStorage(veiculoData) {
    try {
        let veiculos = [];
        const stored = localStorage.getItem('mamcontrol_veiculos');
        if (stored) {
            veiculos = JSON.parse(stored);
        }
        
        // Verificar se placa já existe
        const placaExiste = veiculos.some(v => v.placa === veiculoData.placa);
        if (!placaExiste) {
            veiculos.push({
                id: Date.now(),
                ...veiculoData
            });
            localStorage.setItem('mamcontrol_veiculos', JSON.stringify(veiculos));
            console.log('Veículo sincronizado com sucesso:', veiculoData.placa);
        } else {
            console.log('Veículo já existe no cadastro de veículos:', veiculoData.placa);
        }
    } catch (error) {
        console.error('Erro ao salvar veículo no localStorage:', error);
    }
}

// Função para alternar entre tag manual e remoto
function toggleVeiculoTagFields() {
    const tipo = document.querySelector('input[name="tipo-tag-veiculo"]:checked')?.value || 'manual';
    const manualContainer = document.getElementById('veiculo-tag-manual-container');
    const remotoContainer = document.getElementById('veiculo-tag-remoto-container');
    
    if (manualContainer && remotoContainer) {
        if (tipo === 'manual') {
            manualContainer.classList.remove('hidden');
            remotoContainer.classList.add('hidden');
        } else {
            manualContainer.classList.add('hidden');
            remotoContainer.classList.remove('hidden');
        }
    }
}

// Função para gerar tag aleatória
function gerarVeiculoTagAleatoria() {
    const tag = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
    const tagInput = document.getElementById('veiculo-tag-numero');
    if (tagInput) {
        tagInput.value = tag;
    }
}

// Função para iniciar cadastramento remoto de tag veicular
function iniciarVeiculoCadastramentoRemoto() {
    // Simular leitura após 3 segundos
    NotificationSystem.showToast('info', 'Cadastramento Remoto', 'Aproxime o equipamento para ler a tag...');
    
    setTimeout(() => {
        const tag = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');
        const tagInput = document.getElementById('veiculo-tag-numero');
        if (tagInput) {
            tagInput.value = tag;
        }
        // Mudar para modo manual
        const manualRadio = document.querySelector('input[name="tipo-tag-veiculo"][value="manual"]');
        if (manualRadio) manualRadio.checked = true;
        toggleVeiculoTagFields();
        NotificationSystem.showToast('success', 'Tag Lida', `Tag lida com sucesso: ${tag}`);
    }, 3000);
}

function cancelAddVeiculo() {
    document.getElementById('veiculo-form-container').style.display = 'none';
}

function removeVeiculo(button) {
    button.closest('tr').remove();
    const tbody = document.getElementById('veiculos-table-body');
    if (tbody.querySelectorAll('tr').length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">Nenhum veículo cadastrado</td></tr>';
    }
}

function addCartaoManual() {
    NotificationSystem.showToast('info', 'Cartão', 'Funcionalidade de cartão em desenvolvimento');
}

function cadastrarCartaoRemoto() {
    NotificationSystem.showToast('info', 'Cartão Remoto', 'Funcionalidade futura - Integração com leitores');
}

function showNotifications() {
    NotificationSystem.showToast('info', 'Notificações', 'Sistema de notificações em desenvolvimento.');
}

function showHelp() {
    NotificationSystem.showToast('info', 'Ajuda', 'Documentação em desenvolvimento.');
}

async function logout() {
    try {
        // Tentar fazer logout no backend
        await api.logout();
    } catch (error) {
        console.error('Erro ao fazer logout no servidor:', error);
    } finally {
        // Limpar estado local
        STATE.accessToken = null;
        STATE.refreshToken = null;
        STATE.user = null;
        
        localStorage.removeItem('mamcontrol_accessToken');
        localStorage.removeItem('mamcontrol_refreshToken');
        localStorage.removeItem('mamcontrol_user');
        localStorage.removeItem('mamcontrol_loginTime');
        localStorage.removeItem('mamcontrol_tenant');
        
        // Redirecionar para página de login
        redirectToLogin();
    }
}

function redirectToLogin() {
    // Se já estiver na página de login, não fazer nada
    if (window.location.pathname.endsWith('index.html') || 
        window.location.pathname === '/' ||
        window.location.pathname.endsWith('/')) {
        return;
    }
    
    // Calcular prefixo baseado na profundidade do caminho
    const path = window.location.pathname;
    const depth = (path.match(/\//g) || []).length - 1;
    const prefix = depth > 1 ? '../../' : depth === 1 ? '../' : '';
    
    window.location.href = prefix + 'index.html';
}

// ============================================
// INICIALIZAÇÃO DA APLICAÇÃO
// ============================================

// ============================================
// LOGIN MANAGER
// ============================================
class LoginManager {
    static showLogin() {
        const loginScreen = document.getElementById('login-screen');
        const appContainer = document.getElementById('app-container');
        
        if (loginScreen) loginScreen.classList.remove('hidden');
        if (appContainer) appContainer.classList.add('hidden');
    }

    static hideLogin() {
        const loginScreen = document.getElementById('login-screen');
        const appContainer = document.getElementById('app-container');
        
        if (loginScreen) loginScreen.classList.add('hidden');
        if (appContainer) appContainer.classList.remove('hidden');
        
        // Atualizar footer com nome do tenant (se o elemento existir)
        const tenantName = localStorage.getItem('mamcontrol_tenant') || 'unknown';
        const footerTenantName = document.getElementById('footer-tenant-name');
        if (footerTenantName) {
            footerTenantName.textContent = tenantName;
        }
    }

    static async handleLogin(event) {
        event.preventDefault();
        
        const tenant = document.getElementById('login-tenant').value.trim();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const errorDiv = document.getElementById('login-error');
        
        console.log('=== handleLogin called ===', { tenant, email });
        
        errorDiv.classList.add('hidden');
        
        if (!tenant || !email || !password) {
            errorDiv.textContent = 'Por favor, preencha todos os campos';
            errorDiv.classList.remove('hidden');
            return;
        }
        
        try {
            // Atualizar tenant ID no API service
            api.tenantId = tenant;
            
            const result = await api.login(email, password);
            
            if (result.success) {
                // Salvar tokens e dados do usuário
                STATE.accessToken = result.data.accessToken;
                STATE.refreshToken = result.data.refreshToken;
                STATE.user = result.data.user;
                
                localStorage.setItem('mamcontrol_accessToken', STATE.accessToken);
                localStorage.setItem('mamcontrol_refreshToken', STATE.refreshToken);
                
                // Salvar dados do usuário incluindo permissões do perfil
                const userData = {
                    ...result.data.user,
                    profilePermissions: result.data.profilePermissions || [],
                    profileName: result.data.profileName || null
                };
                localStorage.setItem('mamcontrol_user', JSON.stringify(userData));
                localStorage.setItem('mamcontrol_tenant', tenant);
                
                // Verificar se é admin master (mamcontrolmam) - redirecionar para admin master
                console.log('Login successful, checking redirect:', { tenant, role: STATE.user?.role });
                if (tenant === 'mamcontrolmam' && STATE.user && STATE.user.role === 'admin') {
                    console.log('Redirecting to admin-master.html');
                    window.location.href = './admin-master.html';
                    return;
                }
                // Verificar se é revenda (tenant com campo revenda_id)
                else if (result.data.isRevenda) {
                    window.location.href = './admin-revenda.html';
                }
                // Verificar se é usuário master/admin do tenant master antigo
                else if (tenant === 'mamcontrol' && STATE.user && STATE.user.role === 'admin') {
                    window.location.href = './create-tenant.html';
                } else {
                    // Esconder tela de login e mostrar app
                    LoginManager.hideLogin();
                    
                    // Inicializar sistema
                    initializeApp();
                }
            }
        } catch (error) {
            console.error('Erro ao fazer login:', error);
            errorDiv.textContent = error.message || 'Credenciais inválidas. Verifique seu tenant, e-mail e senha.';
            errorDiv.classList.remove('hidden');
        }
    }
}

function initializeApp() {
    // Inicializar storage
    storage.init();
    
    // Aplicar máscaras de entrada
    InputMask.applyMasks();
    
    // Inicializar UI
    UIManager.initSidebarState();
    UIManager.updateBadges();
    storage.updateLabels();
    
    // Configurar eventos
    setupEventListeners();
    
    // Carregar dashboard inicial
    DashboardManager.load();
    
    // Exibir notificação de boas-vindas
    setTimeout(() => {
        NotificationSystem.showToast(
            'success',
            'Bem-vindo ao MAM Control',
            'Sistema inicializado com sucesso!',
            3000
        );
    }, 1000);
    
    console.log('MAM Control - Pronto para uso!');
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log('MAM Control - Inicializando...');
    
    // Restaurar tenant do localStorage
    const savedTenant = localStorage.getItem('mamcontrol_tenant');
    if (savedTenant) {
        api.tenantId = savedTenant;
        const loginTenantInput = document.getElementById('login-tenant');
        if (loginTenantInput) {
            loginTenantInput.value = savedTenant;
        }
        const footerTenantName = document.getElementById('footer-tenant-name');
        if (footerTenantName) {
            footerTenantName.textContent = savedTenant;
        }
    }
    
    // Configurar formulário de login
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', (e) => LoginManager.handleLogin(e));
    }
    
    // Verificar se já está autenticado - APENAS se estiver na página com tela de login
    const hasLoginScreen = document.getElementById('login-screen');
    if (STATE.accessToken && STATE.refreshToken && hasLoginScreen) {
        // Verificar se o token ainda é válido
        try {
            const result = await api.request('/auth/me');
            if (result.success && result.data) {
                // Token válido, atualizar dados do usuário e inicializar app
                STATE.user = result.data;
                localStorage.setItem('mamcontrol_user', JSON.stringify(STATE.user));
                
                // Verificar se é usuário master/admin do tenant master
                const savedTenant = localStorage.getItem('mamcontrol_tenant');
                if (savedTenant === 'mamcontrol' && STATE.user && STATE.user.role === 'admin') {
                    // Redirecionar para página de criar tenant
                    window.location.href = './create-tenant.html';
                    return;
                }
                
                LoginManager.hideLogin();
                initializeApp();
                return;
            }
        } catch (error) {
            console.log('Token inválido, tentando refresh...', error.message);
            // Token inválido, tentar refresh
            try {
                const refreshed = await api.refreshAccessToken();
                if (refreshed) {
                    // Refresh bem-sucedido, verificar novamente
                    const result = await api.request('/auth/me');
                    if (result.success && result.data) {
                        STATE.user = result.data;
                        localStorage.setItem('mamcontrol_user', JSON.stringify(STATE.user));
                        
                        // Verificar se é usuário master/admin do tenant master
                        const savedTenant = localStorage.getItem('mamcontrol_tenant');
                        if (savedTenant === 'mamcontrol' && STATE.user && STATE.user.role === 'admin') {
                            // Redirecionar para página de criar tenant
                            window.location.href = './create-tenant.html';
                            return;
                        }
                        
                        LoginManager.hideLogin();
                        initializeApp();
                        return;
                    }
                }
            } catch (refreshError) {
                console.log('Refresh falhou, fazendo logout...', refreshError.message);
            }
            
            // Se refresh também falhou, limpar e mostrar login
            STATE.accessToken = null;
            STATE.refreshToken = null;
            STATE.user = null;
            localStorage.removeItem('mamcontrol_accessToken');
            localStorage.removeItem('mamcontrol_refreshToken');
            localStorage.removeItem('mamcontrol_user');
            localStorage.removeItem('mamcontrol_loginTime');
            // Não remover tenant, para facilitar novo login
        }
    }
    
    // Se não estiver autenticado E a tela de login existir, mostrar tela de login
    if (!STATE.accessToken && hasLoginScreen) {
        LoginManager.showLogin();
    }
    
    // Se estiver no dashboard (sem tela de login) e não tiver token, 
    // o auth.js já vai redirecionar para index.html
});

// ============================================
// GERENCIADOR DE VEÍCULOS
// ============================================

class VeiculoManager {
    static currentPage = 1;
    static limit = 50;
    static totalRecords = 0;
    static totalPages = 1;
    
    static async loadList() {
        try {
            const page = this.currentPage || 1;
            const limit = this.limit || 50;
            
            // Usar API de veículos com paginação
            const response = await ApiService.getAllVehicles(page, limit);
            const veiculos = response.data || [];
            this.totalRecords = response.pagination?.total || 0;
            this.totalPages = response.pagination?.totalPages || 1;
            
            const tableBody = document.getElementById('veiculos-table-body');
            const countElement = document.getElementById('veiculos-count');
            
            if (!tableBody) return;
            
            if (veiculos.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center">
                            <div class="no-data">
                                <i class="fas fa-car"></i>
                                <p>Nenhum veículo cadastrado</p>
                            </div>
                        </td>
                    </tr>
                `;
                if (countElement) countElement.textContent = '0';
                this.updatePaginationControls();
                return;
            }
            
            let html = '';
            veiculos.forEach(veiculo => {
                // Determinar tipo de vaga
                let vagaDisplay = '-';
                let vagaTipo = '';
                if (veiculo.parking_id) {
                    vagaDisplay = 'Vaga ID: ' + veiculo.parking_id;
                    vagaTipo = 'fixa';
                } else if (veiculo.company_id) {
                    vagaDisplay = 'Empresa ID: ' + veiculo.company_id;
                    vagaTipo = 'rotativa';
                }
                
                html += `
                    <tr>
                        <td><strong>${veiculo.license_plate || veiculo.plate || 'N/A'}</strong></td>
                        <td>${veiculo.brand || ''}</td>
                        <td>${veiculo.model || ''}</td>
                        <td>${veiculo.color || ''}</td>
                        <td>${veiculo.year || ''}</td>
                        <td>${veiculo.person_name || 'N/A'}</td>
                        <td>
                            <button class="btn btn-sm btn-edit" onclick="VeiculoManager.edit('${veiculo.person_id}')" title="Editar">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-danger" onclick="VeiculoManager.confirmDelete('${veiculo.id}')" title="Deletar">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
            
            tableBody.innerHTML = html;
            
            if (countElement) {
                countElement.textContent = `${this.totalRecords} veículo${this.totalRecords !== 1 ? 's' : ''}`;
            }
            
            this.updatePaginationControls();
            
        } catch (error) {
            console.error('Erro ao carregar veículos:', error);
            const tableBody = document.getElementById('veiculos-table-body');
            if (tableBody) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="7" class="text-center text-danger">
                            Erro ao carregar veículos: ${error.message}
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    static updatePaginationControls() {
        const prevBtn = document.getElementById('veiculos-prev-btn');
        const nextBtn = document.getElementById('veiculos-next-btn');
        const pageInfo = document.getElementById('veiculos-page-info');
        
        if (prevBtn) prevBtn.disabled = this.currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this.currentPage >= this.totalPages;
        if (pageInfo) pageInfo.textContent = `Página ${this.currentPage} de ${this.totalPages}`;
    }
    
    static async nextPage() {
        if (this.currentPage < this.totalPages) {
            this.currentPage++;
            await this.loadList();
        }
    }
    
    static async prevPage() {
        if (this.currentPage > 1) {
            this.currentPage--;
            await this.loadList();
        }
    }
    
    static async goToPage(page) {
        if (page >= 1 && page <= this.totalPages) {
            this.currentPage = page;
            await this.loadList();
        }
    }

    static filter() {
        const searchTerm = document.getElementById('search-veiculos')?.value.toLowerCase() || '';
        const tableBody = document.getElementById('veiculos-table-body');
        
        if (!tableBody) return;
        
        const rows = tableBody.querySelectorAll('tr');
        let visible = 0;
        
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            const matches = text.includes(searchTerm);
            row.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });
        
        if (visible === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="text-center">Nenhum veículo encontrado</td>
                </tr>
            `;
        }
    }

    static showForm() {
        PessoaManager.showForm();
        // Foco na aba de veículos
        setTimeout(() => {
            const veiculoTab = document.querySelector('[data-tab="veiculo"]');
            if (veiculoTab) veiculoTab.click();
        }, 100);
    }

    static edit(personId) {
        PessoaManager.edit(personId);
        setTimeout(() => {
            const veiculoTab = document.querySelector('[data-tab="veiculo"]');
            if (veiculoTab) veiculoTab.click();
        }, 100);
    }

    static async confirmDelete(personId) {
        const pessoa = await storage.getPessoa(personId);
        if (!pessoa) return;
        
        const vehicle = pessoa.vehicle || pessoa.veiculo;
        const placa = vehicle?.license_plate || vehicle?.placa || 'desconhecida';
        
        UIManager.showModal(
            'Confirmar Exclusão',
            `Tem certeza que deseja deletar o veículo com placa "${placa}"?`,
            () => this.deleteVehicle(personId)
        );
    }

    static async deleteVehicle(personId) {
        try {
            const pessoa = await storage.getPessoa(personId);
            if (pessoa) {
                // Limpar veículo da pessoa
                pessoa.veiculo = null;
                pessoa.vehicle = null;
                await storage.savePessoa(pessoa);
                
                NotificationSystem.showToast('success', 'Deletado', 'Veículo deletado com sucesso');
                this.loadList();
                DashboardManager.load();
            }
        } catch (error) {
            console.error('Erro ao deletar veículo:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível deletar o veículo');
        }
    }
}

// ============================================
// GERENCIADOR DE ESTACIONAMENTOS
// ============================================

class EstacionamentoManager {
    static async loadList() {
        try {
            const estacionamentos = await storage.getEstacionamentos();
            const tableBody = document.getElementById('estacionamentos-table-body');
            const countElement = document.getElementById('estacionamentos-count');
            
            if (!tableBody) return;
            
            if (!estacionamentos || estacionamentos.length === 0) {
                tableBody.innerHTML = `
                    <tr>
                        <td colspan="5" class="text-center">
                            <div class="no-data">
                                <i class="fas fa-parking"></i>
                                <p>Nenhum estacionamento cadastrado</p>
                                <button class="btn btn-primary" onclick="EstacionamentoManager.showForm()">
                                    Cadastrar primeiro estacionamento
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
                if (countElement) countElement.textContent = '0';
                return;
            }
            
            let html = '';
            estacionamentos.forEach(est => {
                const tipo = est.type === 'fixo' ? '🔧 Fixo' : '🔄 Rotativo';
                const vagas = est.type === 'fixo' 
                    ? `${est.available_spots || 0}/${est.total_spots || 0}`
                    : (est.total_spots === 9999 ? 'Ilimitado' : est.total_spots || 'Sem limite');
                const status = est.active ? 'Ativo' : 'Inativo';
                const statusClass = est.active ? 'ativo' : 'inativo';
                
                html += `
                    <tr>
                        <td><strong>${est.name}</strong></td>
                        <td>${tipo}</td>
                        <td>${vagas}</td>
                        <td><span class="status-badge ${statusClass}">${status}</span></td>
                        <td>
                            <div class="action-buttons">
                                <button class="btn btn-sm btn-edit" onclick="EstacionamentoManager.edit(${est.id})" title="Editar">
                                    <i class="fas fa-edit"></i>
                                </button>
                                <button class="btn btn-sm btn-danger" onclick="EstacionamentoManager.confirmDelete(${est.id})" title="Deletar">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            });
            
            tableBody.innerHTML = html;
            if (countElement) countElement.textContent = estacionamentos.length;
        } catch (error) {
            console.error('Erro ao carregar estacionamentos:', error);
            const tableBody = document.getElementById('estacionamentos-table-body');
            if (tableBody) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center">Erro ao carregar dados</td></tr>';
            }
        }
    }

    static refresh() {
        this.loadList();
    }

    static filter() {
        const searchTerm = document.getElementById('search-estacionamentos')?.value.toLowerCase() || '';
        // TODO: Implementar filtro se necessário
        this.loadList();
    }

    static async showForm(id = null) {
        const listView = document.getElementById('estacionamentos-list');
        const formView = document.getElementById('estacionamentos-form');
        
        // Verificar se elementos existem (podem não existir em outras páginas)
        if (!formView) {
            console.warn('Formulário de estacionamento não encontrado');
            return;
        }
        
        if (listView) listView.classList.add('hidden');
        formView.classList.remove('hidden');
        
        this.clearForm();
        STATE.editMode = !!id;
        STATE.currentEditId = id;
        
        if (id) {
            await this.loadFormData(id);
        } else {
            // Novo estacionamento - mostrar apenas tipo rotativo inicialmente
            document.getElementById('estacionamento-tipo').value = 'rotativo';
            this.toggleTipoFields();
        }
    }

    static showList() {
        const listView = document.getElementById('estacionamentos-list');
        const formView = document.getElementById('estacionamentos-form');
        
        // Verificar se elementos existem (podem não existir em outras páginas)
        if (!listView || !formView) return;
        
        listView.classList.remove('hidden');
        formView.classList.add('hidden');
        
        this.loadList();
    }

    // Função para confirmar cancelamento (pergunta se deseja excluir)
    static async confirmarCancelamento() {
        const estacionamentoId = document.getElementById('estacionamento-id')?.value;
        
        // Se tem ID e não está em modo de edição (não tinha ID antes), perguntar sobre excluir
        if (estacionamentoId && !STATE.currentEditId) {
            const confirmar = confirm('Você está cancelling o cadastro de um novo estacionamento. Deseja excluir o que foi criado?');
            if (confirmar) {
                try {
                    await storage.deleteEstacionamento(estacionamentoId);
                    NotificationSystem.showToast('success', 'Excluído', 'Estacionamento excluído com sucesso');
                } catch (error) {
                    console.error('Erro ao excluir:', error);
                }
            }
        }
        
        this.showList();
    }

    static clearForm() {
        const form = document.getElementById('form-estacionamento');
        if (form) {
            form.reset();
            document.getElementById('estacionamento-id').value = '';
        }
    }

    static async loadFormData(id) {
        try {
            const est = await storage.getEstacionamento(id);
            if (!est) {
                NotificationSystem.showToast('error', 'Erro', 'Estacionamento não encontrado');
                this.showList();
                return;
            }
            
            document.getElementById('estacionamento-id').value = est.id;
            document.getElementById('estacionamento-nome').value = est.name;
            document.getElementById('estacionamento-tipo').value = est.type;
            
            // Elementos do DOM
            const fixoContainer = document.getElementById('estacionamento-vagas-fixo-container');
            const rotativoContainer = document.getElementById('estacionamento-vagas-rotativo-container');
            const vagasSection = document.getElementById('estacionamento-vagas-section');
            
            if (est.type === 'fixo') {
                if (fixoContainer) fixoContainer.style.display = 'block';
                if (rotativoContainer) rotativoContainer.style.display = 'none';
                if (vagasSection) vagasSection.classList.remove('hidden');
                
                // Carregar vagas
                await this.loadVagasList(id);
            } else {
                if (rotativoContainer) rotativoContainer.style.display = 'block';
                if (fixoContainer) fixoContainer.style.display = 'none';
                if (vagasSection) vagasSection.classList.add('hidden');
                
                const spots = est.total_spots === 9999 ? '' : est.total_spots;
                document.getElementById('estacionamento-vagas-rotativo').value = spots;
                
                // Carregar distribuição de vagas por empresa para tipo rotativo
                if (est.empresas && est.empresas.length > 0) {
                    // Atualizar as vagas das empresas no array global
                    if (window.EMPRESAS_ESTACIONAMENTO && window.EMPRESAS_ESTACIONAMENTO.length > 0) {
                        window.EMPRESAS_ESTACIONAMENTO = window.EMPRESAS_ESTACIONAMENTO.map(emp => {
                            const empData = est.empresas.find(e => e.empresaId === emp.id);
                            return {
                                ...emp,
                                vagas: empData ? empData.vagas : 0
                            };
                        });
                        // Atualizar também a propriedade estática
                        this.empresasRotativo = window.EMPRESAS_ESTACIONAMENTO;
                    }
                    
                    // Atualizar o display
                    if (typeof atualizarListaEmpresasForm === 'function') {
                        atualizarListaEmpresasForm();
                    }
                    if (typeof atualizarTotalDisplay === 'function') {
                        atualizarTotalDisplay();
                    }
                }
            }
            
            // Carregar vagas se existir (para tipo fixo)
            if (est.spots && est.spots.length > 0) {
                const vagasHtml = est.spots.map(vaga => `
                    <tr>
                        <td>${vaga.spot_number}</td>
                        <td><span class="status-badge ${vaga.status}">${vaga.status === 'available' ? 'Disponível' : vaga.status === 'occupied' ? 'Ocupada' : vaga.status}</span></td>
                        <td>
                            <button class="btn btn-sm btn-danger" onclick="EstacionamentoManager.deleteVaga(${est.id}, ${vaga.id})">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                `).join('');
                
                const tableBody = document.getElementById('vagas-table-body');
                if (tableBody) {
                    tableBody.innerHTML = vagasHtml;
                }
            }
        } catch (error) {
            console.error('Erro ao carregar dados do estacionamento:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível carregar os dados');
        }
    }

    static toggleTipoFields() {
        const tipo = document.getElementById('estacionamento-tipo').value;
        const fixoContainer = document.getElementById('estacionamento-vagas-fixo-container');
        const rotativoContainer = document.getElementById('estacionamento-vagas-rotativo-container');
        const vagasSection = document.getElementById('estacionamento-vagas-section');
        
        if (tipo === 'fixo') {
            if (fixoContainer) fixoContainer.style.display = 'block';
            if (rotativoContainer) rotativoContainer.style.display = 'none';
            if (vagasSection) vagasSection.classList.remove('hidden');
        } else {
            if (fixoContainer) fixoContainer.style.display = 'none';
            if (rotativoContainer) rotativoContainer.style.display = 'block';
            if (vagasSection) vagasSection.classList.add('hidden');
        }
    }

    static showVagaForm() {
        const container = document.getElementById('vaga-form-container');
        if (container) {
            container.style.display = container.style.display === 'none' ? 'block' : 'none';
        }
    }

    static showBulkVagaForm() {
        const container = document.getElementById('vaga-bulk-form-container');
        if (container) {
            container.style.display = container.style.display === 'none' ? 'block' : 'none';
        }
    }

    static async addVaga(event) {
        if (event) event.preventDefault();
        
        const estacionamentoIdEl = document.getElementById('estacionamento-id');
        let estacionamentoId = parseInt(estacionamentoIdEl?.value);
        const spotNumber = document.getElementById('vaga-numero')?.value.trim();
        
        if (!spotNumber) {
            NotificationSystem.showToast('error', 'Erro', 'Número da vaga inválido');
            return;
        }
        
        // Se não tem ID, salvar o estacionamento primeiro
        if (!estacionamentoId) {
            // Criar o objeto estacionamento
            const nome = document.getElementById('estacionamento-nome')?.value.trim();
            const tipo = document.getElementById('estacionamento-tipo')?.value;
            
            if (!nome || !tipo) {
                NotificationSystem.showToast('error', 'Erro', 'Nome e tipo são obrigatórios');
                return;
            }
            
            const estacionamento = {
                name: nome,
                type: tipo,
                total_spots: 0,
                active: 1
            };
            
            try {
                const saved = await storage.saveEstacionamento(estacionamento);
                if (saved && saved.id) {
                    estacionamentoId = saved.id;
                    estacionamentoIdEl.value = saved.id;
                    // Atualizar STATE.currentEditId também
                    STATE.currentEditId = saved.id;
                    STATE.editMode = true;
                    NotificationSystem.showToast('success', 'Estacionamento Salvo', 'Estacionamento salvo, adicionando vaga...');
                } else {
                    NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o estacionamento');
                    return;
                }
            } catch (error) {
                console.error('Erro ao salvar estacionamento:', error);
                NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o estacionamento');
                return;
            }
        }
        
        try {
            await storage.addVaga(estacionamentoId, { spot_number: spotNumber });
            NotificationSystem.showToast('success', 'Vaga Adicionada', 'Vaga adicionada com sucesso');
            document.getElementById('vaga-numero').value = '';
            await this.loadVagasList(estacionamentoId);
        } catch (error) {
            console.error('Erro ao adicionar vaga:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível adicionar a vaga');
        }
    }

    static async addVagasBulk(event) {
        if (event) event.preventDefault();
        
        const estacionamentoIdEl = document.getElementById('estacionamento-id');
        let estacionamentoId = parseInt(estacionamentoIdEl?.value);
        const startNum = parseInt(document.getElementById('vaga-inicio')?.value);
        const endNum = parseInt(document.getElementById('vaga-fim')?.value);
        
        if (isNaN(startNum) || isNaN(endNum) || startNum > endNum) {
            NotificationSystem.showToast('error', 'Erro', 'Valores inválidos para cadastro em massa');
            return;
        }
        
        // Se não tem ID, significa que o estacionamento ainda não foi salvo
        // Primeiro salvar o estacionamento
        if (!estacionamentoId) {
            const nome = document.getElementById('estacionamento-nome')?.value.trim();
            const tipo = document.getElementById('estacionamento-tipo')?.value;
            
            if (!nome || !tipo) {
                NotificationSystem.showToast('error', 'Erro', 'Nome e tipo são obrigatórios');
                return;
            }
            
            const estacionamento = {
                name: nome,
                type: tipo,
                total_spots: 0,
                active: 1
            };
            
            try {
                const saved = await storage.saveEstacionamento(estacionamento);
                if (saved && saved.id) {
                    estacionamentoId = saved.id;
                    estacionamentoIdEl.value = saved.id;
                    // Atualizar STATE.currentEditId também
                    STATE.currentEditId = saved.id;
                    STATE.editMode = true;
                    NotificationSystem.showToast('success', 'Estacionamento Salvo', 'Estacionamento salvo, adicionando vagas...');
                } else {
                    NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o estacionamento');
                    return;
                }
            } catch (error) {
                console.error('Erro ao salvar estacionamento:', error);
                NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o estacionamento');
                return;
            }
        }
        
        try {
            const prefix = document.getElementById('vaga-prefixo')?.value.trim() || '';
            await storage.addVagasBulk(estacionamentoId, { start_number: startNum, end_number: endNum, prefix: prefix });
            const prefixMsg = prefix ? ` com prefixo "${prefix}"` : '';
            NotificationSystem.showToast('success', 'Vagas Adicionadas', `${endNum - startNum + 1} vagas adicionadas${prefixMsg}`);
            document.getElementById('vaga-prefixo').value = '';
            document.getElementById('vaga-inicio').value = '';
            document.getElementById('vaga-fim').value = '';
            await this.loadVagasList(estacionamentoId);
        } catch (error) {
            console.error('Erro ao adicionar vagas:', error);
            NotificationSystem.showToast('error', 'Erro', error.message || 'Não foi possível adicionar as vagas');
        }
    }

    static async loadVagasList(estacionamentoId) {
        try {
            const est = await storage.getEstacionamento(estacionamentoId);
            const tableBody = document.getElementById('vagas-table-body');
            
            if (!tableBody || !est.spots || est.spots.length === 0) {
                if (tableBody) {
                    tableBody.innerHTML = '<tr><td colspan="3" class="text-center">Nenhuma vaga cadastrada</td></tr>';
                }
                return;
            }
            
            const vagasHtml = est.spots.map(vaga => `
                <tr>
                    <td>${vaga.spot_number}</td>
                    <td><span class="status-badge ${vaga.status}">${vaga.status === 'available' ? 'Disponível' : vaga.status === 'occupied' ? 'Ocupada' : vaga.status}</span></td>
                    <td>
                        <button class="btn btn-sm btn-danger" onclick="EstacionamentoManager.deleteVaga(${estacionamentoId}, ${vaga.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
            
            tableBody.innerHTML = vagasHtml;
        } catch (error) {
            console.error('Erro ao carregar vagas:', error);
        }
    }

    static async deleteVaga(estacionamentoId, vagaId) {
        try {
            await storage.deleteVaga(estacionamentoId, vagaId);
            NotificationSystem.showToast('success', 'Vaga Removida', 'Vaga removida com sucesso');
            await this.loadVagasList(estacionamentoId);
        } catch (error) {
            console.error('Erro ao remover vaga:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível remover a vaga');
        }
    }

    static async save(event) {
        event.preventDefault();
        
        const id = STATE.editMode ? parseInt(document.getElementById('estacionamento-id').value) : null;
        const nome = document.getElementById('estacionamento-nome').value.trim();
        const tipo = document.getElementById('estacionamento-tipo').value;
        let totalSpots = null;
        
        if (!nome || !tipo) {
            NotificationSystem.showToast('error', 'Erro', 'Nome e tipo são obrigatórios');
            return;
        }
        
        if (tipo === 'rotativo') {
            const vagasInput = document.getElementById('estacionamento-vagas-rotativo').value;
            totalSpots = vagasInput ? parseInt(vagasInput) : 9999;
        } else if (tipo === 'fixo') {
            // Para tipo fixo, total_spots será calculado pelas vagas
            const tableBody = document.getElementById('vagas-table-body');
            if (tableBody && tableBody.rows.length > 0) {
                totalSpots = tableBody.rows.length;
            }
        }
        
        const estacionamento = {
            id: id,
            name: nome,
            type: tipo,
            total_spots: totalSpots || null,
            active: 1
        };
        
        // Para tipo rotativo, salvar distribuição de vagas por empresa
        if (tipo === 'rotativo' && window.EMPRESAS_ESTACIONAMENTO) {
            const empresasComVagas = window.EMPRESAS_ESTACIONAMENTO
                .filter(e => (parseInt(e.vagas) || 0) > 0)
                .map(e => ({
                    empresaId: e.id,
                    vagas: parseInt(e.vagas) || 0
                }));
            
            if (empresasComVagas.length > 0) {
                estacionamento.empresas = empresasComVagas;
            }
        }
        
        try {
            const saved = await storage.saveEstacionamento(estacionamento);
            NotificationSystem.showToast(
                'success',
                STATE.editMode ? 'Atualizado' : 'Cadastrado',
                `Estacionamento "${nome}" foi ${STATE.editMode ? 'atualizado' : 'cadastrado'} com sucesso!`
            );
            this.showList();
            DashboardManager.load();
        } catch (error) {
            console.error('Erro ao salvar estacionamento:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível salvar o estacionamento');
        }
    }

    static edit(id) {
        this.showForm(id);
    }

    static async confirmDelete(id) {
        const est = await storage.getEstacionamento(id);
        if (!est) return;
        
        UIManager.showModal(
            'Confirmar Exclusão',
            `Tem certeza que deseja excluir o estacionamento "${est.name}"? Esta ação não pode ser desfeita.`,
            () => this.delete(id)
        );
    }

    static async delete(id) {
        try {
            await storage.deleteEstacionamento(id);
            NotificationSystem.showToast('success', 'Excluído', 'Estacionamento excluído com sucesso');
            this.loadList();
            DashboardManager.load();
        } catch (error) {
            console.error('Erro ao deletar:', error);
            NotificationSystem.showToast('error', 'Erro', 'Não foi possível deletar o estacionamento');
        }
    }

    // ============================================
    // MÉTODOS PARA EMPRESAS E VAGAS ROTATIVAS
    // ============================================
    
    // Variável global para empresas do estacionamento rotativo
    static get empresasRotativo() {
        if (!this._empresasRotativo) {
            this._empresasRotativo = [];
        }
        return this._empresasRotativo;
    }
    
    static set empresasRotativo(value) {
        this._empresasRotativo = value;
    }
    
    // Carregar empresas do banco de dados
    static async carregarEmpresasDoBanco() {
        console.log('Carregando empresas do banco de dados...');
        try {
            // Buscar todas as empresas sem limite (usando limit=10000)
            const result = await api.request('/companies?limit=10000');
            console.log('Resultado da API de empresas:', result);
            
            if (result.success && result.data && result.data.length > 0) {
                const empresasFormatadas = result.data.map(e => ({
                    id: e.id,
                    nome: e.trading_name || e.corporate_name || e.name || e.nome || 'Empresa ' + e.id,
                    documento: e.cnpj || e.documento || '',
                    vagas: 0
                }));
                
                // Atualizar tanto a propriedade estática quanto a variável global
                this.empresasRotativo = empresasFormatadas;
                window.EMPRESAS_ESTACIONAMENTO = empresasFormatadas;
                
                console.log('Empresas carregadas do banco:', this.empresasRotativo);
            } else {
                this.empresasRotativo = [];
                window.EMPRESAS_ESTACIONAMENTO = [];
                console.log('Nenhuma empresa encontrada na API');
            }
        } catch (error) {
            console.error('Erro ao carregar empresas:', error);
            this.empresasRotativo = [];
            window.EMPRESAS_ESTACIONAMENTO = [];
        }
    }
    
    // Atualizar vagas de uma empresa
    static atualizarVagasEmpresa(empresaId, vagas) {
        // Atualizar na propriedade estática
        const empresa = this.empresasRotativo.find(e => e.id === empresaId);
        if (empresa) {
            empresa.vagas = parseInt(vagas) || 0;
            this.atualizarContadorEmpresas();
            this.calcularTotalVagas();
        }
        
        // Também atualizar na variável global para manter sincronizado
        const empresaGlobal = window.EMPRESAS_ESTACIONAMENTO?.find(e => e.id === empresaId);
        if (empresaGlobal) {
            empresaGlobal.vagas = parseInt(vagas) || 0;
        }
    }
    
    // Atualizar contador de empresas ativas
    static atualizarContadorEmpresas() {
        const ativas = this.empresasRotativo.filter(e => e.vagas > 0).length;
        const elemento = document.getElementById('empresas-selecionadas-count');
        if (elemento) {
            elemento.textContent = `${ativas} empresas ativas`;
        }
    }
    
    // Calcular total de vagas distribuídas
    static calcularTotalVagas() {
        const totalVagasInput = document.getElementById('estacionamento-vagas-rotativo');
        if (!totalVagasInput) return;
        
        const totalVagas = parseInt(totalVagasInput.value) || 0;
        const totalDistribuido = this.empresasRotativo.reduce((acc, e) => acc + (e.vagas || 0), 0);
        
        const distribuidoEl = document.getElementById('total-vagas-distribuidas');
        const disponivelEl = document.getElementById('total-vagas-disponiveis');
        
        if (distribuidoEl) distribuidoEl.textContent = totalDistribuido;
        if (disponivelEl) disponivelEl.textContent = totalVagas;
        
        // Validação visual
        if (distribuidoEl) {
            if (totalDistribuido > totalVagas && totalVagas > 0) {
                distribuidoEl.style.color = '#ef4444';
            } else {
                distribuidoEl.style.color = '#4a90d9';
            }
        }
    }
    
    // Toggle campos baseado no tipo
    static toggleTipoFields() {
        const tipoEl = document.getElementById('estacionamento-tipo');
        if (!tipoEl) return;
        
        const tipo = tipoEl.value;
        const vagasRotativo = document.getElementById('estacionamento-vagas-rotativo-container');
        const empresasVagas = document.getElementById('empresas-vagas-container');
        const vagasSection = document.getElementById('estacionamento-vagas-section');

        if (tipo === 'rotativo') {
            if (vagasRotativo) vagasRotativo.style.display = 'block';
            if (empresasVagas) empresasVagas.style.display = 'block';
            if (vagasSection) vagasSection.classList.add('hidden');
            this.calcularTotalVagas();
        } else {
            if (vagasRotativo) vagasRotativo.style.display = 'none';
            if (empresasVagas) empresasVagas.style.display = 'none';
            if (vagasSection) vagasSection.classList.remove('hidden');
        }
    }
}

// ============================================
// FUNÇÕES GLOBAIS PARA ESTACIONAMENTO
// ============================================

    // ============================================
    // FUNÇÕES GLOBAIS PARA ESTACIONAMENTO
    // ============================================

// Função para atualizar a lista de empresas no formulário (chamada pelo HTML)
function atualizarListaEmpresasForm() {
    const container = document.getElementById('empresas-list');
    if (!container) return;
    
    const empresas = window.EMPRESAS_ESTACIONAMENTO;
    
    if (!empresas || empresas.length === 0) {
        container.innerHTML = '<div class="empty-message"><i class="fas fa-building"></i><p>Nenhuma empresa cadastrada</p></div>';
        return;
    }
    
    container.innerHTML = empresas.map(empresa => `
        <div class="empresa-item" data-empresa-id="${empresa.id}">
            <div class="empresa-info">
                <div class="empresa-nome">${empresa.nome || 'Empresa ' + empresa.id}</div>
                <div class="empresa-documento">${empresa.documento || ''}</div>
            </div>
            <div class="empresa-vagas">
                <input type="number" class="vagas-empresa-input" 
                    data-empresa-id="${empresa.id}" 
                    data-empresa-nome="${empresa.nome || ''}"
                    min="0" step="1" value="${empresa.vagas || 0}" placeholder="Vagas"
                    onchange="EstacionamentoManager.atualizarVagasEmpresa(${empresa.id}, this.value); atualizarTotalDisplay();"
                    onkeyup="EstacionamentoManager.atualizarVagasEmpresa(${empresa.id}, this.value); atualizarTotalDisplay();">
            </div>
        </div>
    `).join('');
    
    // Atualizar contador e total
    atualizarTotalDisplay();
}

// Função para atualizar o display do total
function atualizarTotalDisplay() {
    const empresas = window.EMPRESAS_ESTACIONAMENTO || [];
    const totalVagasInput = document.getElementById('estacionamento-vagas-rotativo');
    const totalVagas = parseInt(totalVagasInput?.value) || 0;
    
    const totalDistribuido = empresas.reduce((acc, e) => acc + (parseInt(e.vagas) || 0), 0);
    
    const distribuidoEl = document.getElementById('total-vagas-distribuidas');
    const disponivelEl = document.getElementById('total-vagas-disponiveis');
    
    if (distribuidoEl) distribuidoEl.textContent = totalDistribuido;
    if (disponivelEl) disponivelEl.textContent = totalVagas;
    
    // Validação visual
    if (distribuidoEl) {
        if (totalDistribuido > totalVagas && totalVagas > 0) {
            distribuidoEl.style.color = '#ef4444';
        } else {
            distribuidoEl.style.color = '#4a90d9';
        }
    }
    
    // Atualizar contador de empresas
    const ativas = empresas.filter(e => (parseInt(e.vagas) || 0) > 0).length;
    const countEl = document.getElementById('empresas-selecionadas-count');
    if (countEl) countEl.textContent = `${ativas} empresas ativas`;
}

// Registrar as funções globalmente
window.atualizarListaEmpresasForm = atualizarListaEmpresasForm;
window.atualizarTotalDisplay = atualizarTotalDisplay;

function setupEventListeners() {
    // Navegação do menu
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const section = item.getAttribute('data-section');
            if (section) {
                showSection(section);
            }
        });
    });
    
    // Abas de formulário
    document.querySelectorAll('.form-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            if (tabName) {
                switchTab(tabName);
            }
        });
    });
    
    // Busca CEP automática
    const cepInput = document.getElementById('pessoa-cep');
    if (cepInput) {
        cepInput.addEventListener('blur', () => {
            const cep = cepInput.value.replace(/\D/g, '');
            if (cep.length === 8) {
                fetch(`https://viacep.com.br/ws/${cep}/json/`)
                    .then(response => response.json())
                    .then(data => {
                        if (!data.erro) {
                            document.getElementById('pessoa-endereco').value = data.logradouro;
                            document.getElementById('pessoa-bairro').value = data.bairro;
                            document.getElementById('pessoa-cidade').value = data.localidade;
                            document.getElementById('pessoa-estado').value = data.uf;
                        }
                    })
                    .catch(error => {
                        console.error('Erro ao buscar CEP:', error);
                    });
            }
        });
    }
    
    // Prevenir envio duplo de formulários
    document.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit', function(e) {
            const submitBtn = this.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = true;
                setTimeout(() => {
                    submitBtn.disabled = false;
                }, 2000);
            }
        });
    });
}

// ============================================
// FUNÇÕES GLOBAIS (para eventos onclick no HTML)
// ============================================
function closeModal() {
    UIManager.closeModal();
}
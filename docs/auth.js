// Configuração de expiração de sessão (em milissegundos)
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas
const SESSION_WARNING_TIME = 30 * 60 * 1000; // 30 minutos antes de expirar

function checkAuth() {
    const token = localStorage.getItem('acesscontrol_accessToken');
    const loginTime = localStorage.getItem('acesscontrol_loginTime');
    
    if (!token) {
        redirectToLogin();
        return false;
    }
    
    // Verificar se a sessão expirou
    if (loginTime) {
        const currentTime = Date.now();
        const elapsed = currentTime - parseInt(loginTime);
        
        if (elapsed > SESSION_TIMEOUT) {
            console.log('Sessão expirada após', Math.floor(elapsed / (1000 * 60 * 60)), 'horas');
            clearSession();
            redirectToLogin();
            return false;
        }
        
        // Verificar se está próximo de expirar (30 minutos)
        const timeRemaining = SESSION_TIMEOUT - elapsed;
        if (timeRemaining < SESSION_WARNING_TIME && timeRemaining > 0) {
            const minutesRemaining = Math.floor(timeRemaining / (1000 * 60));
            console.warn('Sessão expira em', minutesRemaining, 'minutos');
        }
    }
    
    return true;
}

function clearSession() {
    localStorage.removeItem('acesscontrol_accessToken');
    localStorage.removeItem('acesscontrol_refreshToken');
    localStorage.removeItem('acesscontrol_user');
    localStorage.removeItem('acesscontrol_tenant');
    localStorage.removeItem('acesscontrol_loginTime');
    localStorage.removeItem('auth_token'); // Limpar token antigo se existir
}

function redirectToLogin() {
    const currentPath = window.location.pathname;
    
    // Se já estiver na página de login, não fazer nada
    if (currentPath.endsWith('index.html') || 
        currentPath === '/' ||
        currentPath.endsWith('/') ||
        currentPath.includes('/index.html')) {
        return;
    }
    
    // Calcular prefixo baseado na profundidade do caminho
    const depth = (currentPath.match(/\//g) || []).length - 1;
    const prefix = depth > 1 ? '../../' : depth === 1 ? '../' : '';
    
    window.location.href = prefix + 'index.html';
}

function loadUserInfo() {
    const userName = localStorage.getItem('user_name') || 'Usuário';
    const userRole = localStorage.getItem('user_role') || 'Administrador';
    const tenantName = localStorage.getItem('tenant_id') || 'Empresa';
    
    const userNameEl = document.getElementById('user-name');
    const userRoleEl = document.getElementById('user-role');
    const tenantEl = document.getElementById('sidebar-tenant-name');
    
    if (userNameEl) userNameEl.textContent = userName.toUpperCase();
    if (userRoleEl) userRoleEl.textContent = userRole;
    if (tenantEl) tenantEl.textContent = tenantName.toUpperCase();
}

// Função para carregar user info com retry (espera o DOM estar pronto)
async function loadUserInfoWithRetry(retries = 10, delay = 100) {
    for (let i = 0; i < retries; i++) {
        const tenantEl = document.getElementById('sidebar-tenant-name');
        const userNameEl = document.getElementById('user-name');
        
        if (tenantEl || userNameEl) {
            loadUserInfo();
            return;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    // Se não encontrou, tenta uma última vez
    loadUserInfo();
}

// Verificar autenticação periodicamente (a cada 5 minutos)
function startSessionCheck() {
    setInterval(() => {
        if (!checkAuth()) {
            console.log('Sessão inválida detectada, redirecionando...');
        }
    }, 5 * 60 * 1000); // 5 minutos
}

// Executar verificação de autenticação em todas as páginas exceto login
const isLoginPage = window.location.pathname === '/index.html' || 
                    window.location.pathname.endsWith('index.html') || 
                    window.location.pathname === '/' ||
                    window.location.pathname.endsWith('/');

if (!isLoginPage) {
    // Sempre tenta carregar as informações do usuário, independentemente do resultado de checkAuth
    document.addEventListener('DOMContentLoaded', () => {
        console.log('Auth: Carregando informações do usuário...');
        // Usar versão com retry para garantir que o sidebar foi renderizado
        loadUserInfoWithRetry();
        
        // Verifica autenticação em segundo plano
        if (checkAuth()) {
            startSessionCheck();
        } else {
            console.log('Auth: Sessão inválida, mas mantendo na página para debug');
        }
    });
}

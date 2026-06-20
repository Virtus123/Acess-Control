// Funções para carregar dados do banco para nivelacesso-pessoas.html

// Carregar regras de acesso do banco — apenas as de PESSOAS, não veículos.
async function carregarRegras() {
    try {
        const result = await api.getAccessRules('persons');
        console.log('=== CARREGAR REGRAS ===');
        console.log('Resultado API:', result);
        
        // Verificar se é array direto ou objeto com success/data
        if (Array.isArray(result)) {
            regras = result;
        } else if (result && result.success && Array.isArray(result.data)) {
            regras = result.data;
        } else {
            regras = [];
        }
        console.log('Regras carregadas:', regras);
        renderizarLista();
    } catch (error) {
        console.error('Erro ao carregar regras:', error);
        regras = [];
        renderizarLista();
    }
}

// Carregar pessoas do banco
async function carregarPessoas() {
    try {
        const data = await api.getPersons();
        const pessoas = Array.isArray(data) ? data : (data.success ? data.data : []);
        const container = document.getElementById('pessoas-lista');
        
        if (container) {
            if (pessoas.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhuma pessoa cadastrada</p>';
            } else {
                container.innerHTML = pessoas.map(p => {
                    const nomeExibicao = p.name || p.nome || p.nome_pessoa || 'Sem nome';
                    return `<div class="selecao-item"><input type="checkbox" value="${p.id}" onchange="atualizarContadores()"><span>${nomeExibicao}</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar pessoas:', error);
    }
}

// Carregar visitantes do banco
async function carregarVisitantes() {
    try {
        const data = await api.getVisitors();
        const visitantes = Array.isArray(data) ? data : (data.success ? data.data : []);
        const container = document.getElementById('visitantes-lista');
        
        if (container) {
            if (visitantes.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhum visitante cadastrado</p>';
            } else {
                container.innerHTML = visitantes.map(v => {
                    const nomeExibicao = v.name || v.nome || 'Sem nome';
                    return `<div class="selecao-item"><input type="checkbox" value="v-${v.id}" onchange="atualizarContadores()"><span>${nomeExibicao}</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar visitantes:', error);
    }
}

// Carregar grupos do banco
async function carregarGrupos() {
    try {
        const data = await api.getGroups();
        const grupos = Array.isArray(data) ? data : (data.success ? data.data : []);
        const container = document.getElementById('grupos-lista');
        
        if (container) {
            if (grupos.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhum grupo cadastrado</p>';
            } else {
                container.innerHTML = grupos.map(g => {
                    const nomeExibicao = g.name || g.nome || 'Sem nome';
                    return `<div class="selecao-item"><input type="checkbox" value="${g.id}" onchange="atualizarContadores()"><span>${nomeExibicao}</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar grupos:', error);
    }
}

// Carregar empresas do banco
async function carregarEmpresas() {
    try {
        const data = await api.getAllCompanies();
        const empresas = Array.isArray(data) ? data : [];
        const container = document.getElementById('empresas-lista');
        
        if (container) {
            if (empresas.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhuma empresa cadastrada</p>';
            } else {
                container.innerHTML = empresas.map(e => {
                    const nomeExibicao = e.name || e.nome || e.corporate_name || e.trading_name || 'Sem nome';
                    return `<div class="selecao-item"><input type="checkbox" value="${e.id}" onchange="atualizarContadores()"><span>${nomeExibicao}</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar empresas:', error);
    }
}

// Carregar equipamentos do banco
async function carregarEquipamentos() {
    try {
        const data = await api.getEquipments();
        const equipamentos = Array.isArray(data) ? data : (data.success ? data.data : []);
        const container = document.getElementById('equipamentos-lista');
        
        if (container) {
            if (equipamentos.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhum equipamento cadastrado</p>';
            } else {
                container.innerHTML = equipamentos.map(e => {
                    const nomeExibicao = e.name || e.nome || e.equip_name || 'Sem nome';
                    const ipExibicao = e.ip || e.equip_ip || 'Sem IP';
                    return `<div class="selecao-item"><input type="checkbox" value="${e.id}" onchange="atualizarContadores()"><span>${nomeExibicao} (${ipExibicao})</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar equipamentos:', error);
    }
}

// Carregar horarios do banco
async function carregarHorarios() {
    try {
        const result = await api.getSchedules();
        const horarios = Array.isArray(result) ? result : (result.success ? result.data : []);
        const container = document.getElementById('horarios-lista');
        
        if (container) {
            if (horarios.length === 0) {
                container.innerHTML = '<p style="padding: 10px; color: #666;">Nenhum horario cadastrado</p>';
            } else {
                container.innerHTML = horarios.map(h => {
                    const nomeExibicao = h.name || h.nome || h.schedule_name || 'Sem nome';
                    return `<div class="selecao-item"><input type="checkbox" value="${h.id}" onchange="atualizarContadores()"><span>${nomeExibicao}</span></div>`;
                }).join('');
            }
        }
    } catch (error) {
        console.error('Erro ao carregar horarios:', error);
    }
}

// Salvar regra com API
function salvarRegra(e) {
    e.preventDefault();

    const nome = document.getElementById('regra-nome')?.value;
    if (!nome) {
        alert('Digite um nome para a regra!');
        return;
    }

    const access_type = document.querySelector('input[name="tipo-acesso"]:checked')?.value;
    const schedule_type = document.querySelector('input[name="tipo-horario"]:checked')?.value;

    if (!access_type || !schedule_type) {
        alert('Erro ao obter selecoes!');
        return;
    }

    // Validar selecoes
    if (access_type !== 'todos' && access_type !== 'pessoas-geral' && access_type !== 'visitantes-geral') {
        const containerId = {
            'pessoas-especificas': 'pessoas-lista',
            'empresas': 'empresas-lista',
            'grupos': 'grupos-lista'
        }[access_type];
        
        if (containerId) {
            const container = document.getElementById(containerId);
            if (container) {
                const selecionados = container.querySelectorAll('input[type="checkbox"]:checked').length;
                if (selecionados === 0) {
                    alert('Selecione pelo menos um item!');
                    return;
                }
            }
        }
    }

    // Coletar equipamentos (opcional - se não selecionados, a regra se aplica a qualquer equipamento)
    const equipamentosSelecionados = Array.from(
        document.querySelectorAll('#equipamentos-lista input[type="checkbox"]:checked')
    ).map(cb => parseInt(cb.value));
    
    // Removido: validação obrigatória de equipamentos
    // if (equipamentosSelecionados.length === 0) {
    //     alert('Selecione pelo menos um equipamento!');
    //     return;
    // }

    if (schedule_type === 'especifico') {
        const horariosSelecionados = Array.from(
            document.querySelectorAll('#horarios-lista input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));
        
        if (horariosSelecionados.length === 0) {
            alert('Selecione pelo menos um horario!');
            return;
        }
    }

    // Coletar dados conforme o tipo de acesso
    let persons = [];
    let companies = [];
    let groups = [];
    let schedules = [];

    if (access_type === 'pessoas-especificas') {
        persons = Array.from(
            document.querySelectorAll('#pessoas-lista input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));
    } else if (access_type === 'empresas') {
        companies = Array.from(
            document.querySelectorAll('#empresas-lista input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));
    } else if (access_type === 'grupos') {
        groups = Array.from(
            document.querySelectorAll('#grupos-lista input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));
    }

    if (schedule_type === 'especifico') {
        schedules = Array.from(
            document.querySelectorAll('#horarios-lista input[type="checkbox"]:checked')
        ).map(cb => parseInt(cb.value));
    }

    // Montar dados para API
    const regraData = {
        name: nome,
        access_type: access_type,
        persons: persons,
        companies: companies,
        groups: groups,
        equipments: equipamentosSelecionados,
        schedule_type: schedule_type,
        schedules: schedules
    };

    console.log('=== SALVAR REGRA ===');
    console.log('Dados enviados:', regraData);
    console.log('editandoId:', editandoId);

    // Salvar no banco de dados
    if (editandoId) {
        // Atualizar
        console.log('Chamando API updateAccessRule...');
        api.updateAccessRule(editandoId, regraData).then(result => {
            console.log('Resultado da API:', result);
            if (result && result.success) {
                alert('Regra atualizada com sucesso!');
                carregarRegras();
                mostrarLista();
            } else {
                alert('Erro ao atualizar regra: ' + (result?.message || 'Erro desconhecido'));
            }
        }).catch(error => {
            console.error('Erro ao atualizar regra:', error);
            alert('Erro ao atualizar regra');
        });
    } else {
        // Criar novo
        console.log('Chamando API createAccessRule...');
        api.createAccessRule(regraData).then(result => {
            console.log('Resultado da API:', result);
            if (result && result.success) {
                alert('Regra criada com sucesso!');
                carregarRegras();
                mostrarLista();
            } else {
                alert('Erro ao criar regra: ' + (result?.message || 'Erro desconhecido'));
            }
        }).catch(error => {
            console.error('Erro ao criar regra:', error);
            alert('Erro ao criar regra');
        });
    }
}

// Editar regra
function editarRegra(id) {
    console.log('=== EDITAR REGRA - INICIO ===');
    console.log('ID da regra:', id);
    const regra = regras.find(r => r.id === id);
    console.log('Regra encontrada:', regra);
    if (!regra) return;

    editandoId = id;
    document.getElementById('regra-nome').value = regra.name || regra.nome || '';
    document.getElementById('regra-id').value = id;
    document.getElementById('form-titulo').textContent = 'Editar Regra de Acesso';

    // Selecionar tipo de acesso
    const accessType = regra.access_type || regra.tipo;
    console.log('Access type:', accessType);
    const radioTipo = document.querySelector(`input[name="tipo-acesso"][value="${accessType}"]`);
    if (radioTipo) {
        radioTipo.checked = true;
        console.log('Radio tipo acesso marcado');
    } else {
        console.log('ERRO: Radio tipo acesso NAO encontrado');
    }

    toggleTipoAcesso();

    // Selecionar tipo de horario
    const scheduleType = regra.schedule_type || regra.tipoHorario;
    console.log('Schedule type:', scheduleType);
    const radioHorario = document.querySelector(`input[name="tipo-horario"][value="${scheduleType}"]`);
    if (radioHorario) {
        radioHorario.checked = true;
        console.log('Radio horario marcado');
    } else {
        console.log('ERRO: Radio horario NAO encontrado');
    }

    toggleHorario();

    console.log('Carregando dados para edição...');
    
    // Primeiro carrega os dados, depois seleciona os checkboxes
    Promise.all([
        carregarPessoas(),
        carregarVisitantes(),
        carregarGrupos(),
        carregarEmpresas(),
        carregarEquipamentos(),
        carregarHorarios()
    ]).then(() => {
        console.log('Dados carregados, marcando checkboxes...');
        console.log('Container pessoas:', document.getElementById('pessoas-lista'));
        console.log('Container empresas:', document.getElementById('empresas-lista'));
        console.log('Container grupos:', document.getElementById('grupos-lista'));
        console.log('Container equipamentos:', document.getElementById('equipamentos-lista'));
        console.log('Container horarios:', document.getElementById('horarios-lista'));
        
        // Aguarda um pouco para o DOM atualizar
        setTimeout(() => {
            console.log('Marcando checkboxes...');
            
            // Equipamentos
            if (regra.equipments || regra.equipamentos) {
                const equips = regra.equipments || regra.equipamentos;
                console.log('Equipamentos da regra:', equips);
                equips.forEach(eqId => {
                    const cb = document.querySelector(`#equipamentos-lista input[value="${eqId}"]`);
                    console.log(`Buscando equipamento ${eqId}:`, cb);
                    if (cb) cb.checked = true;
                });
            }
            
            // Pessoas
            if (regra.persons) {
                console.log('Pessoas da regra:', regra.persons);
                regra.persons.forEach(pId => {
                    const cb = document.querySelector(`#pessoas-lista input[value="${pId}"]`);
                    console.log(`Buscando pessoa ${pId}:`, cb);
                    if (cb) cb.checked = true;
                });
            }
            
            // Empresas
            if (regra.companies) {
                console.log('Empresas da regra:', regra.companies);
                regra.companies.forEach(cId => {
                    const cb = document.querySelector(`#empresas-lista input[value="${cId}"]`);
                    console.log(`Buscando empresa ${cId}:`, cb);
                    if (cb) cb.checked = true;
                });
            }
            
            // Grupos
            if (regra.groups) {
                console.log('Grupos da regra:', regra.groups);
                regra.groups.forEach(gId => {
                    const cb = document.querySelector(`#grupos-lista input[value="${gId}"]`);
                    console.log(`Buscando grupo ${gId}:`, cb);
                    if (cb) cb.checked = true;
                });
            }
            
            // Horarios
            if (regra.schedules) {
                console.log('Horarios da regra:', regra.schedules);
                regra.schedules.forEach(hId => {
                    const cb = document.querySelector(`#horarios-lista input[value="${hId}"]`);
                    console.log(`Buscando horario ${hId}:`, cb);
                    if (cb) cb.checked = true;
                });
            }
            
            atualizarContadores();
            console.log('=== EDITAR REGRA - FIM ===');
        }, 500);
    });

    mostrarFormulario();
}

// Excluir regra
function excluirRegra(id) {
    if (confirm('Deseja realmente excluir esta regra de acesso?')) {
        api.deleteAccessRule(id).then(result => {
            if (result && result.success) {
                alert('Regra excluida com sucesso!');
                carregarRegras();
            } else {
                alert('Erro ao excluir regra: ' + (result?.message || 'Erro desconhecido'));
            }
        }).catch(error => {
            console.error('Erro ao excluir regra:', error);
            alert('Erro ao excluir regra');
        });
    }
}

// Funções de busca
function buscarPessoas(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('pessoas-lista');
    if (!container) return;
    
    const checkboxes = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    checkboxes.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function buscarVisitantes(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('visitantes-lista');
    if (!container) return;
    
    const items = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    items.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function buscarGrupos(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('grupos-lista');
    if (!container) return;
    
    const items = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    items.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function buscarEmpresas(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('empresas-lista');
    if (!container) return;
    
    const items = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    items.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function buscarEquipamentos(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('equipamentos-lista');
    if (!container) return;
    
    const items = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    items.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

function buscarHorarios(termo) {
    if (!termo) termo = '';
    const container = document.getElementById('horarios-lista');
    if (!container) return;
    
    const items = container.querySelectorAll('.selecao-item');
    const termoLower = termo.toLowerCase();
    
    items.forEach(item => {
        const texto = item.textContent.toLowerCase();
        if (texto.includes(termoLower)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
}

// Função para inicializar quando o DOM estiver carregado
function initNivelAcesso() {
    // Carregar dados do banco
    carregarRegras();
    carregarPessoas();
    carregarVisitantes();
    carregarGrupos();
    carregarEmpresas();
    carregarEquipamentos();
    carregarHorarios();

    // Garantir que o formulário comece escondido
    const lista = document.getElementById('regras-list');
    const form = document.getElementById('regras-form');
    if (lista) lista.classList.remove('hidden');
    if (form) form.classList.add('hidden');
}

// Renderizar lista de regras
function renderizarLista() {
    console.log('=== RENDERIZAR LISTA ===');
    console.log('Regras:', regras);
    const tbody = document.getElementById('regras-table-body');
    
    if (!tbody) {
        console.error('Elemento regras-table-body não encontrado');
        return;
    }
    
    if (!regras || regras.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5">
                    <div class="empty-message">
                        <i class="fas fa-shield-alt"></i>
                        <p>Nenhuma regra de acesso cadastrada</p>
                        <button class="btn btn-primary btn-sm" onclick="mostrarFormulario()" style="margin-top: 12px;">
                            <i class="fas fa-plus"></i> Criar primeira regra
                        </button>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    const tipoLabel = {
        'todos': 'Todos',
        'pessoas-geral': 'Pessoas (Geral)',
        'pessoas-especificas': 'Pessoas (Específicas)',
        'visitantes-geral': 'Visitantes (Geral)',
        'grupos': 'Grupos',
        'empresas': 'Empresas'
    };
    
    tbody.innerHTML = regras.map(r => {
        console.log('Renderizando regra:', r);
        return `
            <tr>
                <td><strong>${r.name || r.nome || 'Sem nome'}</strong></td>
                <td><span class="badge badge-info">${tipoLabel[r.access_type] || r.access_type || 'N/A'}</span></td>
                <td>${r.equipments ? r.equipments.length : 0} equipamento(s)</td>
                <td><span class="badge badge-success">${r.schedule_type === 'todos' ? '24/7' : 'Horário específico'}</span></td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="editarRegra(${r.id})" title="Editar">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="excluirRegra(${r.id})" title="Excluir">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// Mostrar formulário
function mostrarFormulario() {
    const lista = document.getElementById('regras-list');
    const form = document.getElementById('regras-form');
    
    if (lista && form) {
        lista.classList.add('hidden');
        form.classList.remove('hidden');
        
        const titulo = document.getElementById('form-titulo');
        if (titulo && !editandoId) titulo.textContent = 'Nova Regra de Acesso';
        
        // Só faz reset se não estiver editando
        if (!editandoId) {
            const formEl = document.getElementById('regraForm');
            if (formEl) formEl.reset();
            
            const idEl = document.getElementById('regra-id');
            if (idEl) idEl.value = '';
        }
        
        // Resetar selections apenas se não estiver editando
        if (!editandoId) {
            const radioPessoas = document.querySelector('input[name="tipo-acesso"][value="pessoas-especificas"]');
            if (radioPessoas) radioPessoas.checked = true;
            
            const radioHorario = document.querySelector('input[name="tipo-horario"][value="especifico"]');
            if (radioHorario) radioHorario.checked = true;
        }
        
        toggleTipoAcesso();
        toggleHorario();
        atualizarContadores();
    }
}

// Mostrar lista
function mostrarLista() {
    const lista = document.getElementById('regras-list');
    const form = document.getElementById('regras-form');
    
    if (lista && form) {
        lista.classList.remove('hidden');
        form.classList.add('hidden');
        editandoId = null;
    }
}

// Atualizar contadores de seleção
function atualizarContadores() {
    const pessoasCount = document.querySelectorAll('#pessoas-lista input[type="checkbox"]:checked').length;
    const pessoasEl = document.getElementById('pessoas-count');
    if (pessoasEl) pessoasEl.textContent = pessoasCount + ' selecionadas';

    const visitantesCount = document.querySelectorAll('#visitantes-lista input[type="checkbox"]:checked').length;
    const visitantesEl = document.getElementById('visitantes-count');
    if (visitantesEl) visitantesEl.textContent = visitantesCount + ' selecionados';

    const gruposCount = document.querySelectorAll('#grupos-lista input[type="checkbox"]:checked').length;
    const gruposEl = document.getElementById('grupos-count');
    if (gruposEl) gruposEl.textContent = gruposCount + ' selecionados';

    const empresasCount = document.querySelectorAll('#empresas-lista input[type="checkbox"]:checked').length;
    const empresasEl = document.getElementById('empresas-count');
    if (empresasEl) empresasEl.textContent = empresasCount + ' selecionadas';

    const equipamentosCount = document.querySelectorAll('#equipamentos-lista input[type="checkbox"]:checked').length;
    const equipamentosEl = document.getElementById('equipamentos-count');
    if (equipamentosEl) equipamentosEl.textContent = equipamentosCount + ' selecionados';

    const horariosCount = document.querySelectorAll('#horarios-lista input[type="checkbox"]:checked').length;
    const horariosEl = document.getElementById('horarios-count');
    if (horariosEl) horariosEl.textContent = horariosCount + ' selecionados';
}

// Toggle tipo de acesso
function toggleTipoAcesso() {
    const tipo = document.querySelector('input[name="tipo-acesso"]:checked')?.value;
    
    if (!tipo) return;
    
    // Esconder todos os containers
    const containers = ['container-pessoas-especificas', 'container-pessoas-geral', 'container-visitantes-geral', 'container-empresas', 'container-grupos'];
    containers.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    
    // Mostrar o container apropriado
    const containerMostrar = {
        'pessoas-especificas': 'container-pessoas-especificas',
        'pessoas-geral': 'container-pessoas-geral',
        'visitantes-geral': 'container-visitantes-geral',
        'empresas': 'container-empresas',
        'grupos': 'container-grupos'
    }[tipo];
    
    if (containerMostrar) {
        const el = document.getElementById(containerMostrar);
        if (el) el.classList.remove('hidden');
    }
}

// Toggle tipo de horário
function toggleHorario() {
    const tipo = document.querySelector('input[name="tipo-horario"]:checked')?.value;
    
    const horarioEspecifico = document.getElementById('horario-especifico');
    if (!horarioEspecifico) return;
    
    if (tipo === 'especifico') {
        horarioEspecifico.style.display = 'block';
    } else {
        horarioEspecifico.style.display = 'none';
    }
}

// Sobrescrever a função mostrarLista
const originalMostrarLista = window.mostrarLista;
window.mostrarLista = function() {
    carregarRegras();
    if (originalMostrarLista) {
        originalMostrarLista();
    }
};

// Substituir as funções quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', function() {
    // Expor variáveis globalmente
    window.regras = regras;
    window.editandoId = editandoId;
    
    // Substituir as funções do formulario
    window.salvarRegra = salvarRegra;
    window.editarRegra = editarRegra;
    window.excluirRegra = excluirRegra;
    window.carregarRegras = carregarRegras;
    window.carregarPessoas = carregarPessoas;
    window.carregarVisitantes = carregarVisitantes;
    window.carregarGrupos = carregarGrupos;
    window.carregarEmpresas = carregarEmpresas;
    window.carregarEquipamentos = carregarEquipamentos;
    window.carregarHorarios = carregarHorarios;
    window.buscarPessoas = buscarPessoas;
    window.buscarGrupos = buscarGrupos;
    window.buscarEmpresas = buscarEmpresas;
    window.buscarEquipamentos = buscarEquipamentos;
    window.buscarHorarios = buscarHorarios;
    window.renderizarLista = renderizarLista;
    window.mostrarFormulario = mostrarFormulario;
    window.mostrarLista = mostrarLista;
    window.atualizarContadores = atualizarContadores;
    window.toggleTipoAcesso = toggleTipoAcesso;
    window.toggleHorario = toggleHorario;
    
    // Inicializar
    initNivelAcesso();
});

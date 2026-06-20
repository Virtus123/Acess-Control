-- Migration 022: Tabela de Encomendas
-- Sistema de controle de encomendas com suporte para app mobile

CREATE TABLE IF NOT EXISTS encomendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Código de rastreamento
    codigo TEXT,
    
    -- Dados da encomenda
    tipo TEXT DEFAULT 'pacote',
    categoria TEXT,
    urgente INTEGER DEFAULT 0,
    peso REAL,
    dimensoes TEXT,
    descricao TEXT,
    observacoes TEXT,
    
    -- Dados do destinatário
    destinatario_nome TEXT NOT NULL,
    destinatario_documento TEXT,
    destinatario_telefone TEXT,
    destinatario_email TEXT,
    destinatario_unidade TEXT,
    destinatario_bloco TEXT,
    
    -- Dados do remetente
    remetente_nome TEXT,
    remetente_documento TEXT,
    remetente_telefone TEXT,
    remetente_origem TEXT,
    
    -- Datas
    data_chegada DATETIME DEFAULT CURRENT_TIMESTAMP,
    data_retirada DATETIME,
    data_entrega_app DATETIME,
    
    -- Status: pendente, aguarda_retirada, entregue, atraso
    status TEXT DEFAULT 'pendente',
    
    -- Para app mobile - assinatura digital
    assinatura_app TEXT,
    ip_recebimento TEXT,
    device_recebimento TEXT,
    
    -- Responsável
    responsavel_retirada TEXT,
    created_by INTEGER,
    
    -- Timestamps
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Índice para buscas
CREATE INDEX IF NOT EXISTS idx_encomendas_status ON encomendas(status);
CREATE INDEX IF NOT EXISTS idx_encomendas_codigo ON encomendas(codigo);
CREATE INDEX IF NOT EXISTS idx_encomendas_destinatario ON encomendas(destinatario_nome);
CREATE INDEX IF NOT EXISTS idx_encomendas_data_chegada ON encomendas(data_chegada);

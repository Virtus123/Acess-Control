# Acess Control

Sistema SaaS multi-tenant de **controle de acesso físico** para condomínios, empresas e revendas. Gerencia pessoas, visitantes, veículos, equipamentos biométricos, regras de acesso, estacionamento, refeitórios e relatórios operacionais.

**Autor:** [Vitor Yuri Fernandes](https://github.com/Virtus123)

## Destaques técnicos

- **Backend:** Node.js, Express, SQLite multi-tenant, JWT + refresh token, Argon2/bcrypt
- **Frontend:** SPA vanilla (HTML/CSS/JS), PWA com service worker
- **Integrações:** equipamentos de acesso, fila de sincronização facial, push service, UHF/biometria
- **Operação:** Swagger/OpenAPI, cron jobs, backup automático, rate limiting, Helmet/CSP
- **Arquitetura:** isolamento por tenant, painéis master/revenda/cliente

## Estrutura

```
Acess-Control/
├── backend/          # API REST + push-service + migrations SQL
│   ├── server.js
│   ├── src/
│   └── push-service/
└── frontend/         # Painel web (login, dashboard, cadastros, relatórios)
```

## Módulos principais

| Módulo | Descrição |
|--------|-----------|
| Autenticação | Login, refresh token, reset de senha, perfis admin/master |
| Pessoas e visitantes | Cadastro, fotos, grupos, empresas |
| Equipamentos | Sincronização com controladoras e fila de comandos |
| Regras de acesso | Horários, feriados, autorizações e logs de passagem |
| Estacionamento | Vagas, veículos e integração com equipamentos |
| Relatórios | Exportação PDF/Excel, jobs assíncronos |
| Multi-tenant | Banco SQLite isolado por cliente + gestão de revendas |

## Requisitos

- Node.js 18+
- npm

## Executar localmente

```bash
# 1. Backend
cd backend
cp ../.env.example ../.env   # Linux/macOS — no Windows copie manualmente
npm install
npm run migrate
npm start

# 2. Push service (terminal separado)
cd backend/push-service
node server.js

# 3. Frontend
# Com SERVE_FRONTEND=true no .env, acesse http://localhost:3000
```

Documentação interativa da API: `http://localhost:3000/api-docs`

## Scripts úteis

```bash
cd backend
npm run dev          # hot reload
npm run migrate      # migrations globais
npm run seed         # dados iniciais (se configurado)
```

## Segurança

- Nunca commite arquivos `.env` ou bancos `tenant_*.db`
- Altere `JWT_SECRET`, `JWT_REFRESH_SECRET` e `ADMIN_JWT_SECRET` antes de produção
- Em produção, use HTTPS (`USE_HTTPS=true`) e `NODE_ENV=production`

## Licença

MIT — Copyright (c) 2026 Vitor Yuri Fernandes

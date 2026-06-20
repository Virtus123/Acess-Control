# MAM Push Service

Serviço independente que conversa com equipamentos Control iD em **Modo Push** nativo.
Roda em paralelo ao backend `nexis-backend`, lendo o **mesmo SQLite** (via WAL).

```
Frontend → nexis-backend (3000) ─┐
                                 ├──► SQLite tenant_xxx.db
                       mam-push  ─┘
                       (3001)    ↕ HTTPS
                       ↕ HTTP    Equipamento Control iD
                       Dashboard (na LAN do cliente)
                       /admin/ui
```

## Estrutura

```
push-service/
├── server.js                 ← entry point
├── start.bat / start.ps1     ← rodar local Windows (LAN + debug)
├── README.md                 ← este arquivo
├── tools/                    ← scripts utilitários
│   ├── inspect.js            (CLI: listar tenants, equipamentos, queue)
│   ├── insert-test-person.js
│   ├── fix-access-log.js     (adiciona colunas faltando em access_log)
│   ├── seed-default-rule.js  (cria regra LIBERA_TUDO 24/7 num tenant)
│   ├── diag-bugs.js          (diagnóstico schema + estado)
│   └── check-rules.js
├── public/index.html         ← Dashboard web
├── domain/                   ← Command + commandTranslator
├── application/              ← pollUseCase, resultUseCase, enqueueUseCase
├── infrastructure/           ← tenantDb, outboxRepo, waiters, circuit, auth, logger, migrations
└── interface/                ← pushRoutes, onlineRoutes, internalRoutes, adminRoutes
```

## Como rodar

### Desenvolvimento (Windows, equipamento na LAN)

```cmd
push-service\start.bat
```

Ou PowerShell:

```powershell
push-service\start.ps1
```

Variáveis que ele define:
- `PUSH_HOST=0.0.0.0`         → escuta em todas as interfaces (equipamento alcança via IP LAN)
- `PUSH_PORT=3001`
- `PUSH_TRUST_LAN=1`          → aceita request sem token se vier de IP LAN privada (útil pra teste sem HTTPS)
- `PUSH_DEBUG_INGRESS=1`      → loga TODA request que chega (method, path, ip, query)

### Produção (Linux + PM2)

```bash
pm2 start ecosystem.config.cjs --only nexis-push
pm2 save
pm2 logs nexis-push
```

Variáveis recomendadas (em ecosystem.config.cjs):
- `PUSH_HOST=127.0.0.1`       → só localhost; nginx faz reverse-proxy
- `PUSH_PORT=3001`
- `NODE_ENV=production`
- `PUSH_TRUST_LAN=` (vazio)   → exige autenticação por token na URL
- `PUSH_ADMIN_TOKEN=<random>` → libera acesso ao dashboard de fora da LAN

## Endpoints principais

### Para o equipamento

| Método | Path | O que faz |
|---|---|---|
| `GET`  | `/api/push?deviceId=...&uuid=...`     | Long-poll de até 25s. Devolve comando ou vazio. |
| `POST` | `/api/result?deviceId=...&uuid=...`   | Equipamento devolve resultado do comando. |
| `POST` | `/new_user_identified.fcgi`           | Autorização online (face/cartão/senha). |
| `POST` | `/device_is_alive.fcgi`               | Heartbeat (mantém equipamento "online" no painel). |
| `POST` | `/api/notifications/:event`           | Telemetria, DAO, secbox, operation_mode, etc. |

### Para o backend antigo (loopback)

| Método | Path | O que faz |
|---|---|---|
| `POST` | `/internal/wake`     | Acorda long-poll de um device após backend inserir no `push_outbox`. |
| `POST` | `/internal/enqueue`  | Enfileira + acorda em uma chamada só. |

### Admin / Dashboard

| Método | Path | O que faz |
|---|---|---|
| `GET`  | `/admin/ui/`                                  | Dashboard HTML. |
| `GET`  | `/admin/overview`                             | Snapshot de TODOS tenants/equipamentos + stats. |
| `GET`  | `/admin/devices?tenantId=...`                 | Lista equipamentos de um tenant. |
| `GET`  | `/admin/queue?tenantId=...&deviceId=...`      | `push_outbox` recente. |
| `GET`  | `/admin/logs?lines=100`                       | Tail do `logs/push.log`. |
| `POST` | `/admin/devices/:validador/reprovision`       | Roda `provisioning.js` no equipamento (body: `ip`, `login`, `password`, `server_host`, ...). |
| `POST` | `/admin/devices/:validador/enable-push`       | Liga `push_enabled=1`. body: `{tenantId}`. |
| `POST` | `/admin/devices/:validador/disable-push`      | Desliga. |
| `POST` | `/admin/circuit/close`                        | Fecha circuit breaker. body: `{deviceId}`. |
| `POST` | `/admin/queue/:id/retry`                      | Reenfileira linha `dead`/`error`. |
| `POST` | `/admin/queue/clear-dead`                     | Remove todas linhas mortas de um tenant. |
| `GET`  | `/health`                                     | `{status:'ok'}`. |

## Modelo de autenticação

| Modo | Quando usar | Como |
|---|---|---|
| Token via query  | Produção (HTTPS) | URL `https://server/api?token=<32 hex>`, gravado em `equipments.push_secret`. |
| Trust-LAN        | Teste local      | `PUSH_TRUST_LAN=1`. Aceita IP em `10.x`/`172.16-31.x`/`192.168.x` se `push_enabled=1`. |
| Header           | NÃO suportado    | Firmware Control iD não envia `push_extra_headers`. |

## CHECK constraint do `access_tasks`

Migration `fixAccessTasksConstraint` (em `infrastructure/migrations.js`) detecta tenants
com CHECK antigo (sem `desativar_emergencia`) e recria a tabela. Idempotente, roda
toda vez que o Push abre conexão num tenant novo.

## Logs

- `backend/logs/push.log`         (info + warn + error)
- `backend/logs/push-error.log`   (só errors)

Rotacionado a cada 50MB, 10 arquivos retidos.

## Troubleshooting rápido

| Sintoma | Onde olhar |
|---|---|
| Equipamento "offline" no painel | Confirma `POST /device_is_alive.fcgi` chegando nos logs |
| Comando fica em `in_flight` | A firmware está mandando `/result`? grep nos logs |
| `auth_failed` | `push_secret` no banco bate com `?token=...` da URL configurada? |
| 401 sem token visível | Em modo VPN/proxy verifica `req.headers['x-forwarded-for']` |
| Frontend "Nenhum equipamento respondeu" (emergência) | CHECK constraint sem `desativar_emergencia` — restart do Push roda a fix migration |

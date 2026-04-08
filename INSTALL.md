# Nexus — Guia de Instalação

Este guia cobre a instalação completa da plataforma Nexus em modo de desenvolvimento local e em produção (VPS).

---

## Pré-requisitos

| Ferramenta | Versão mínima | Necessário para |
|---|---|---|
| Docker + Docker Compose | 24+ | Banco de dados, Redis, stack completa |
| Node.js + npm | 20+ | Backend e Frontend |
| Go | 1.21+ | Compilar o agente / simulador DePIN |
| Git | qualquer | Clonar o repositório |
| `terraform` CLI | 1.5+ | *Opcional* — módulo Cloud (AWS/DO) |

---

## 1. Modo Desenvolvimento Local

### 1.1 Clone e configure o ambiente

```bash
git clone <repo-url>
cd Nexus-Deployment-Plataform-main

# Copie o .env de exemplo (já existe um pronto na raiz)
cp .env.example .env   # ou edite o .env existente
```

O `.env` padrão para desenvolvimento:

```env
NODE_ENV=development
PORT=4500
DATABASE_URL=postgresql://nexus_admin:Inbox%402026@127.0.0.1:5432/nexus_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=nexus-dev-jwt-secret-change-in-production
ENCRYPTION_KEY=e1357eaa3a1ca199d708b9580f0c40811316b1df6e55d5404248c3360cfb2713
GITHUB_WEBHOOK_SECRET=dev-webhook-secret
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
FRONTEND_URL=http://localhost:8000
AGENT_WS_PORT=8443
VITE_API_URL=http://localhost:4500/api
EMAIL_USER=dev@nexus.local
EMAIL_PASS=devpass
```

> **Windows:** use `127.0.0.1` em `DATABASE_URL` (não `localhost`) para evitar erro P1001 do Prisma com Docker.

---

### 1.2 Suba Postgres + Redis via Docker

```bash
# Sobe apenas as dependências (sem containers de app)
docker compose -f docker-compose.dev.yml up -d
```

Verifique se os containers estão saudáveis:

```bash
docker compose -f docker-compose.dev.yml ps
```

---

### 1.3 Aplique o schema do banco (Prisma)

```bash
cd backend
npm install

# Gera o cliente Prisma e aplica o schema
npx prisma db push

# Popula o banco com o usuário administrador padrão
npx prisma db seed
```

**Credenciais padrão:**
- E-mail: `admin@cicd.local`
- Senha: `admin123`

---

### 1.4 Inicie o Backend

```bash
# Ainda dentro de backend/
npm run dev
```

O backend sobe em `http://localhost:4500`.  
O servidor WebSocket mTLS para agentes sobe em `wss://localhost:8443`.

---

### 1.5 Inicie o Frontend

Abra um novo terminal:

```bash
cd frontend
npm install
npm run dev
```

O frontend sobe em `http://localhost:5173` (Vite dev server).

---

### 1.6 Acesse o Dashboard

| URL | Descrição |
|---|---|
| `http://localhost:5173` | Dashboard (Vite dev) |
| `http://localhost:4500/api` | API REST |
| `http://localhost:4500/health` | Health check |
| `http://localhost:4500/depin/<slug>/_info` | Info do cluster DePIN |
| `http://localhost:4500/depin/<slug>/<path>` | Ingress HTTP → nós DePIN |

Login com `admin@cicd.local` / `admin123`.

---

## 2. Modo Produção (Docker Compose completo)

```bash
# 1. Edite o .env com segredos reais
nano .env

# 2. Suba toda a stack
docker compose up -d --build

# 3. Aplique o schema do banco
docker exec -it nexus-backend npx prisma db push
docker exec -it nexus-backend npx prisma db seed
```

**Acesso:** `http://localhost:8000` (Nginx servindo o frontend compilado)

### Portas expostas em produção

| Serviço | Porta | Descrição |
|---|---|---|
| Frontend (Nginx) | 8000 | Interface web |
| Backend API | 4500 | REST API + Socket.io |
| Agent WSS | 8443 | WebSocket mTLS para agentes |
| PostgreSQL | 5432 | Banco de dados |
| Redis | 6379 | Cache + rate limit |

---

## 3. Instalar o Agente Nexus em um Servidor Remoto

### 3.1 Gerar token de enrollment

Via dashboard em **Cloud → Agentes → Novo Agente**, ou via API:

```bash
curl -X POST http://localhost:4500/api/v1/agent/nodes \
  -H "Authorization: Bearer <seu-jwt-adm>" \
  -H "Content-Type: application/json" \
  -d '{"name": "meu-servidor-1"}'
```

O token retornado tem validade de **2 horas**.

---

### 3.2 Instalação automática (recomendado)

**Linux / macOS:**
```bash
curl -sSL http://seu-host:4500/install.sh | sudo bash -s -- \
  --token SEU_TOKEN \
  --master wss://seu-host/ws/agent
```

**Windows (PowerShell como Administrador):**
```powershell
Invoke-WebRequest -Uri "http://seu-host:4500/install.ps1" -OutFile install.ps1
.\install.ps1 -Token "SEU_TOKEN" -Master "wss://seu-host/ws/agent"
```

O script baixa o binário, obtém os certificados mTLS via `/api/v1/agent/enroll` e instala o agente como serviço nativo (systemd / Launchd / Windows Service).

---

### 3.3 Verificar conexão

No dashboard, o nó aparece como `ONLINE` em **Cloud → Agentes** assim que o agente conectar via mTLS WebSocket.

```bash
# Logs do agente
journalctl -u nexus-agent -f          # Linux
tail -f /var/log/nexus-agent.log       # macOS
Get-EventLog -LogName Application -Source 'nexus-agent'  # Windows
```

---

## 4. Testando a Camada DePIN (Simulador Local)

Para testar o roteamento DePIN sem servidores físicos, use o simulador Go incluído no repositório.

### 4.1 Pré-requisitos

Backend e banco de dados rodando (passos 1.1–1.5 acima).

### 4.2 Registrar nós de teste

```bash
# Registra 3 nós e salva os tokens em .nexus-dev-tokens
bash scripts/provision-nodes.sh
```

### 4.3 Iniciar simuladores

Cada simulador representa um nó DePIN conectado ao backend:

```bash
# Terminal 1
cd agent
NEXUS_SKIP_TLS=1 go run cmd/sim/main.go \
  -master wss://localhost:8443/ws/agent \
  -token $(sed -n '1p' ../.nexus-dev-tokens) \
  -name node-1

# Terminal 2
NEXUS_SKIP_TLS=1 go run cmd/sim/main.go \
  -master wss://localhost:8443/ws/agent \
  -token $(sed -n '2p' ../.nexus-dev-tokens) \
  -name node-2

# Terminal 3
NEXUS_SKIP_TLS=1 go run cmd/sim/main.go \
  -master wss://localhost:8443/ws/agent \
  -token $(sed -n '3p' ../.nexus-dev-tokens) \
  -name node-3
```

### 4.4 Criar e implantar um app DePIN

No dashboard, acesse **DePIN → Apps → Novo App** e crie um app com slug `meu-app`.  
Em seguida, atribua os nós ao app na aba **Assignments**.

### 4.5 Enviar tráfego pelo Ingress Gateway

```bash
# Listar nós saudáveis
curl http://localhost:4500/depin/meu-app/_info

# Enviar requisição (round-robin entre os nós)
curl http://localhost:4500/depin/meu-app/api/status
curl -X POST http://localhost:4500/depin/meu-app/api/orders \
  -H "Content-Type: application/json" \
  -d '{"item": "test"}'
```

### 4.6 Teste de caos (failover)

```bash
# Matar o node-1 (Ctrl+C no Terminal 1)
# A próxima requisição é automaticamente roteada para node-2 ou node-3
curl http://localhost:4500/depin/meu-app/api/status
```

O ingress detecta a desconexão instantaneamente (sem aguardar timeout) e exclui o nó do pool round-robin.

---

## 5. Build do Agente (binários multiplataforma)

```bash
cd agent
go mod tidy
make all

# Binários gerados em agent/dist/
# nexus-agent-linux-amd64
# nexus-agent-linux-arm64
# nexus-agent-darwin-amd64
# nexus-agent-darwin-arm64
# nexus-agent-windows-amd64.exe
```

---

## 6. Variáveis de Ambiente

| Variável | Obrigatório | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim | URL PostgreSQL (use `127.0.0.1` no Windows) |
| `REDIS_URL` | Sim | URL Redis |
| `JWT_SECRET` | Sim | Segredo JWT (troque em produção) |
| `ENCRYPTION_KEY` | Sim | Chave AES-256 hex (64 chars) para secrets |
| `AGENT_WS_PORT` | Sim | Porta WSS mTLS dos agentes (padrão: `8443`) |
| `FRONTEND_URL` | Sim | Origin permitida pelo CORS |
| `GITHUB_WEBHOOK_SECRET` | Não | HMAC-SHA256 para webhooks do GitHub |
| `GEMINI_API_KEY` | Não | Chave Gemini para análise de repos com IA |
| `DOCKER_PROXY_HOST` | Não | Docker Socket Proxy (padrão: `tcp://localhost:2375`) |
| `EMAIL_USER` | Não | Conta SMTP para e-mails de reset de senha |
| `EMAIL_PASS` | Não | Senha SMTP |

---

## 7. Troubleshooting

### Prisma P1001 — Cannot connect to database

```
Error: P1001: Can't reach database server at localhost:5432
```

**Solução:** troque `localhost` por `127.0.0.1` em `DATABASE_URL`.

### Agente não aparece como ONLINE

- Verifique se a porta `8443` está acessível (`telnet seu-host 8443`)
- Confira os logs do agente (`journalctl -u nexus-agent -f`)
- Certifique-se de que o token ainda é válido (validade 2h)

### Simulador DePIN — sem resposta do proxy

- Verifique que `NEXUS_SKIP_TLS=1` está definido (certificados auto-assinados em dev)
- Confirme que o app tem assignments com status `RUNNING`
- Use o endpoint `/_info` para checar nós saudáveis

### Frontend não conecta à API

- Confirme que `VITE_API_URL` aponta para o backend correto
- Em dev, o backend deve estar rodando em `http://localhost:4500`

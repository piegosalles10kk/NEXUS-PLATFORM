# Nexus — Plataforma de Cloud Distribuída (DePIN)

O **Nexus** é uma plataforma de infraestrutura em nuvem descentralizada (DePIN — Decentralized Physical Infrastructure Network). Transforma hardware ocioso em poder de computação distribuído: qualquer máquina com o agente Nexus instalado passa a integrar um cluster capaz de executar workloads WASM e MicroVMs, com balanceamento de carga, failover automático e roteamento HTTP inteligente — sem depender de provedores de cloud centralizados.

Além da camada DePIN, o Nexus inclui uma stack completa de CI/CD self-hosted equivalente ao Railway/Coolify, com pipeline automatizado, gateway reverso, gestão de servidores cloud e monitoramento em tempo real.

---

## O que o Nexus faz

### DePIN Cloud — Computação Distribuída

- **Nós distribuídos:** qualquer servidor (VPS, bare-metal, Raspberry Pi) conecta ao cluster via agente Nexus com mTLS WebSocket
- **Execução WASM:** workloads WebAssembly distribuídas entre os nós disponíveis
- **MicroVMs com Firecracker:** isolamento nível VM para workloads que exigem kernel próprio
- **Raft consensus:** eleição de líder automática entre os nós de uma app; failover em segundos quando o líder cai
- **Ingress Gateway HTTP:** `GET /depin/<slug>/<caminho>` roteia a requisição para um nó saudável via round-robin; detecção de desconexão instantânea (sem esperar timeout)
- **Failover automático:** monitor detecta nós offline e realoca workloads em até 30 segundos
- **Telemetria em tempo real:** cada nó reporta CPU e memória a cada 10 segundos via WebSocket

### CI/CD Pipeline

- **Análise inteligente (Gemini AI):** detecção automática de framework, porta e geração de Dockerfile otimizado
- **Auto-provisionamento de secrets:** identifica variáveis necessárias via `.env.example` e cria os slots automaticamente
- **Pipeline configurável:** passos de build, test e migrate sugeridos pela IA e customizáveis por projeto
- **Deploy híbrido:** execução local ou em agente remoto via mTLS
- Histórico completo de deploys com logs, hash de commit e cancelamento em tempo real
- Secrets criptografados AES-256-GCM injetados nativamente no container

### Monitoramento & Observabilidade

- Streaming de logs em tempo real via WebSocket
- Métricas de CPU/memória via Socket.io (sem polling) com gráficos históricos
- Health check HTTP por container com latência dinâmica
- Dashboard de cluster DePIN: nós online/offline, contador round-robin, assignments

### API Gateway

- Proxy reverso dinâmico por path (`/minha-api` → `http://container:3000`)
- Auto-registro via Docker Labels — containers sobem com `nexus.proxy.host` e o gateway se atualiza automaticamente
- Traffic management: rate limiting, throttling e circuit breaker via Redis
- Suporte a rotas para URLs externas

### Agente Distribuído

- Binário Go único, multiplataforma (Linux, macOS, Windows — amd64/arm64)
- mTLS WebSocket com CA interna (certificados emitidos no enrollment)
- Instala como serviço nativo: systemd, Launchd ou Windows Service
- Reconexão automática com backoff exponencial
- Auto-update sem downtime
- Executa WASM, MicroVMs e deploys CI/CD no mesmo binário

### Módulo Cloud

- Provisionamento de VMs via Terraform CLI em AWS e DigitalOcean
- Cloud-init instala Docker + agente Nexus automaticamente
- Destruição de servidores pelo painel
- Status em tempo real: `PROVISIONING` → `RUNNING` / `ERROR`

### Segurança

- Autenticação JWT com RBAC: `ADM`, `TECNICO`, `OBSERVADOR`
- mTLS para todos os agentes (CA interna por tenant)
- Secrets AES-256-GCM por projeto
- Docker Socket Proxy — backend nunca acessa o socket diretamente
- Rate limiting e circuit breaker via Redis

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEXUS PLATFORM                           │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   Frontend   │    │     Backend      │    │   Database   │  │
│  │ React + Vite │◄──►│ Express + Prisma │◄──►│  PostgreSQL  │  │
│  │   :5173/8000 │    │      :4500       │    │    Redis     │  │
│  └──────────────┘    └────────┬─────────┘    └──────────────┘  │
│                               │                                 │
│          ┌────────────────────┼────────────────────┐            │
│          │                   │                    │            │
│          ▼                   ▼                    ▼            │
│   ┌─────────────┐   ┌─────────────────┐   ┌───────────────┐   │
│   │  CI/CD      │   │  DePIN Ingress  │   │  Agent WS     │   │
│   │  Pipeline   │   │  /depin/:slug/* │   │  Server :8443 │   │
│   │  (Docker)   │   │  Round-robin    │   │  mTLS + JWT   │   │
│   └─────────────┘   └────────┬────────┘    └───────┬───────┘   │
│                              │                     │            │
└──────────────────────────────┼─────────────────────┼────────────┘
                               │                     │
              HTTP tunnel ◄────┘                     │ WSS mTLS
                                                     │
              ┌──────────────────────────────────────┤
              │              CLUSTER DePIN            │
              │                                      │
              │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
              │  │  Node 1  │  │  Node 2  │  │   Node 3   │  │
              │  │  (WASM)  │  │  (WASM)  │  │  (MicroVM) │  │
              │  │  Raft 🔵 │  │  Raft ⚪ │  │  Raft  ⚪  │  │
              │  └──────────┘  └──────────┘  └────────────┘  │
              └────────────────────────────────────────────────┘
```

---

## Estrutura do Projeto

```
Nexus-Deployment-Plataform-main/
├── backend/                    # Express + TypeScript + Prisma (porta 4500)
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/           # Login, reset de senha, RBAC
│   │   │   ├── projects/       # CRUD de projetos CI/CD
│   │   │   ├── deploys/        # Pipeline CI/CD
│   │   │   ├── secrets/        # Variáveis criptografadas AES-256-GCM
│   │   │   ├── ingress/        # DePIN Ingress Gateway (/depin/*)
│   │   │   ├── gateway/        # API Gateway + proxy dinâmico
│   │   │   ├── lb/             # Load balancer nginx
│   │   │   ├── cloud/          # Providers AWS/DO + Terraform
│   │   │   ├── agent/          # Enrollment e gestão de nós
│   │   │   ├── billing/        # Auditoria de uso e billing DePIN
│   │   │   ├── scheduler/      # Jobs agendados
│   │   │   ├── dashboard/      # Métricas consolidadas
│   │   │   ├── settings/       # Configurações + Docker permissions
│   │   │   └── users/          # Gestão de usuários (ADM)
│   │   └── services/
│   │       ├── depin-ingress.service.ts  # Ingress HTTP → WS tunnel (round-robin)
│   │       ├── agent-ws.service.ts       # Servidor WSS mTLS para agentes
│   │       ├── failover.service.ts       # Monitor de failover DePIN
│   │       ├── monitoring.service.ts     # Health check + métricas
│   │       ├── pipeline.service.ts       # Executor CI/CD
│   │       ├── docker.service.ts         # Dockerode via TCP proxy
│   │       ├── docker-watcher.service.ts # Docker Events → Gateway
│   │       ├── terraform.service.ts      # Wrapper Terraform CLI
│   │       ├── ca.service.ts             # CA interna para mTLS
│   │       └── crypto.service.ts         # AES-256-GCM
│   └── prisma/
│       └── schema.prisma
├── frontend/                   # React + Vite + Tailwind 4 (porta 5173/8000)
│   └── src/pages/
│       ├── DashboardPage.tsx   # Visão geral + métricas
│       ├── ProjectsPage.tsx    # Lista de projetos CI/CD
│       ├── ProjectPage.tsx     # Deploy, secrets, config, logs
│       ├── GatewayPage.tsx     # API Gateway
│       ├── CloudPage.tsx       # Providers cloud + servidores
│       ├── ServerDetailsPage.tsx  # Nós DePIN + métricas
│       └── SettingsPage.tsx    # Configurações do sistema
├── agent/                      # Binário Go cross-platform
│   ├── cmd/
│   │   ├── agent/main.go       # Agente de produção
│   │   └── sim/main.go         # Simulador DePIN para testes locais
│   ├── internal/
│   │   ├── network/            # mTLS + WebSocket + reconexão
│   │   ├── metrics/            # gopsutil CPU/RAM/Disco
│   │   ├── docker/             # Client Docker + stream de logs
│   │   └── updater/            # Auto-update cross-platform
│   └── Makefile
├── scripts/
│   ├── provision-nodes.sh      # Registra nós de teste via API
│   └── chaos-test.sh           # Teste de caos automatizado
├── docker-compose.yml          # Stack completa (produção)
├── docker-compose.dev.yml      # Apenas Postgres + Redis (dev local)
├── .env                        # Variáveis de ambiente
└── INSTALL.md                  # Guia de instalação detalhado
```

---

## Início Rápido (Desenvolvimento Local)

```bash
# 1. Suba Postgres + Redis
docker compose -f docker-compose.dev.yml up -d

# 2. Instale dependências e aplique o schema
cd backend && npm install && npx prisma db push && npx prisma db seed

# 3. Inicie o backend (porta 4500)
npm run dev

# 4. Em outro terminal, inicie o frontend (porta 5173)
cd ../frontend && npm install && npm run dev
```

**Dashboard:** `http://localhost:5173`  
**Login:** `admin@cicd.local` / `admin123`

Para instalação completa, configuração de produção e testes DePIN, consulte [INSTALL.md](INSTALL.md).

---

## Endpoints Principais

| Endpoint | Descrição |
|---|---|
| `POST /api/auth/login` | Autenticação |
| `GET  /api/dashboard` | Métricas consolidadas |
| `GET  /api/projects` | Lista de projetos CI/CD |
| `POST /api/v1/agent/nodes` | Registrar novo nó DePIN |
| `POST /api/v1/agent/enroll` | Emitir certificados mTLS |
| `GET  /depin/:slug/_info` | Info do cluster DePIN (nós online, RR counter) |
| `*    /depin/:slug/*` | Ingress — roteia para nó saudável via round-robin |
| `GET  /health` | Health check da plataforma |

---

## Stack Tecnológica

| Camada | Tecnologias |
|---|---|
| Backend | Node.js 20, Express, TypeScript, Prisma ORM, Socket.io, Zod |
| Frontend | React 18, Vite, Tailwind CSS 4, TanStack Query, Recharts, Lucide |
| Banco de dados | PostgreSQL 16, Redis 7 |
| Agente / Simulador | Go 1.21+, gorilla/websocket, gopsutil, kardianos/service |
| DePIN Runtime | WASM (via agente), Firecracker MicroVMs, Raft consensus |
| Infra | Docker Compose, Nginx, Terraform CLI, Docker Socket Proxy |
| IA | Google Gemini 2.5 Pro/Flash (análise de repositórios CI/CD) |
| Segurança | mTLS (CA interna), JWT RBAC, AES-256-GCM, Rate limiting Redis |

---

## Licença

Projeto Privado — Todos os direitos reservados.

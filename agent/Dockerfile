# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Instala dependências de build
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build para Linux amd64 (target principal dos nós doadores)
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w" -o nexus-agent ./cmd/agent

# ── Stage 2: Runtime ────────────────────────────────────────────────────────────
# Usamos Alpine em vez de scratch para ter shell + docker CLI disponíveis,
# pois o agente executa comandos docker (build, run, stop, rm, etc.)
FROM alpine:3.19

WORKDIR /app

# docker-cli: necessário para deploy de containers
# git: necessário para clone/pull dos repos dos projetos
# ca-certificates: necessário para HTTPS (websocket TLS ao backend)
RUN apk add --no-cache \
        docker-cli \
        git \
        ca-certificates \
        tzdata

# Copia o binário compilado
COPY --from=builder /app/nexus-agent /app/nexus-agent
RUN chmod +x /app/nexus-agent

# Diretório onde os projetos serão clonados pelo agente
RUN mkdir -p /app/projects

# O agente lê o token e a URL do master via variáveis de ambiente:
#   AGENT_TOKEN  — JWT gerado no dashboard Nexus
#   MASTER_URL   — ex: wss://meuhost.com:8443/agent-ws
ENV AGENT_TOKEN=""
ENV MASTER_URL=""

# NVIDIA Container Toolkit — NÃO é instalado aqui.
# Para suporte a GPU, o host onde o container roda precisa ter o toolkit
# instalado (apt-get install nvidia-container-toolkit) e o runtime
# configurado no /etc/docker/daemon.json. O agente detecta isso via
# HasNvidiaToolkit() em runtime — sem necessidade de rebuild da imagem.

EXPOSE 0

ENTRYPOINT ["/app/nexus-agent"]

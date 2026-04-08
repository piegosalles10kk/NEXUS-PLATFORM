# Stage 1: Build Go agent (linux/amd64 and linux/arm64)
FROM golang:alpine AS agent-builder

WORKDIR /agent
COPY agent/go.mod agent/go.sum ./
RUN go mod download

COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o nexus-agent-linux-amd64 ./cmd/agent
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o nexus-agent-linux-arm64 ./cmd/agent
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o nexus-agent-windows-amd64.exe ./cmd/agent

# Stage 2: Build Node.js backend
FROM node:20-alpine AS builder

WORKDIR /app

COPY backend/package*.json ./
COPY backend/prisma ./prisma/

RUN apk add --no-cache python3 make g++ 

RUN npm install

COPY backend/ .

RUN npx prisma generate
RUN npm run build

# Stage 3: Production image
FROM node:20-alpine

WORKDIR /app

# Install Docker CLI, Git, Terraform, OpenSSL and Postgres client (pg_isready for healthcheck)
RUN apk add --no-cache docker-cli git curl unzip openssl postgresql-client && \
    curl -sSL --max-time 120 --retry 3 --retry-delay 5 \
        https://releases.hashicorp.com/terraform/1.7.5/terraform_1.7.5_linux_amd64.zip \
        -o terraform.zip && \
    unzip terraform.zip && \
    mv terraform /usr/local/bin/ && \
    rm terraform.zip

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Copy agent binaries and install script to be served as static files
COPY --from=agent-builder /agent/nexus-agent-linux-amd64 ./public/downloads/nexus-agent-linux-amd64
COPY --from=agent-builder /agent/nexus-agent-linux-arm64 ./public/downloads/nexus-agent-linux-arm64
COPY --from=agent-builder /agent/nexus-agent-windows-amd64.exe ./public/downloads/nexus-agent-windows-amd64.exe
COPY agent/scripts/install.sh ./public/install.sh
COPY agent/scripts/install.ps1 ./public/install.ps1
RUN chmod +x ./public/downloads/nexus-agent-linux-amd64 \
             ./public/downloads/nexus-agent-linux-arm64 \
             ./public/install.sh

COPY backend/scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod +x /app/scripts/docker-entrypoint.sh

EXPOSE 4500
EXPOSE 8443

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

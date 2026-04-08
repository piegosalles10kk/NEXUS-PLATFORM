#!/bin/sh
set -e

# ── Espera o banco de dados aceitar conexões ────────────────────────────────
# O healthcheck do compose já garante isso antes do container subir,
# mas mantemos um fallback aqui para uso sem compose (ci, docker run manual).
echo "Waiting for database to be ready..."
until pg_isready -h "$(echo "$DATABASE_URL" | sed 's|.*@||' | sed 's|/.*||' | sed 's|:.*||')" -p 5432 2>/dev/null; do
  printf '.'
  sleep 1
done
echo " database is ready."

# ── Sincroniza o schema ─────────────────────────────────────────────────────
# db push é idempotente — cria tabelas novas, não destrói existentes
echo "Syncing database schema..."
npx prisma db push --accept-data-loss

# ── Seed do admin inicial ───────────────────────────────────────────────────
# Seed idempotente — verifica se o admin já existe antes de inserir
echo "Seeding initial admin account..."
npx prisma db seed

# ── Inicia a aplicação ──────────────────────────────────────────────────────
echo "Starting Nexus backend..."
exec node dist/server.js

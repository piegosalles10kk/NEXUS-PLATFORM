#!/bin/sh

# Aguarda o banco de dados estar pronto
echo "Waiting for database to be ready..."
sleep 5

# Sincroniza o schema com o banco de dados (cria tabelas se não existirem)
# db push é idempotente — seguro para rodar em todo restart
echo "Syncing database schema..."
npx prisma db push --accept-data-loss

# Roda o seed apenas se necessário (seed é idempotente — verifica se admin já existe)
echo "Seeding initial admin account..."
npx prisma db seed

# Inicia a aplicação
echo "Starting application..."
exec node dist/server.js

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';

// In Docker, env vars are already injected via docker-compose env_file.
// dotenv.config() will pick up any .env file if present locally.
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding the database with Admin account...');

  const adminEmail = 'admin@cicd.local';
  
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    console.log(`Admin user with email ${adminEmail} already exists!`);
    return;
  }

  const hashedPassword = await bcrypt.hash('admin123', 10);

  const admin = await prisma.user.create({
    data: {
      name: 'Administrador do Sistema',
      email: adminEmail,
      passwordHash: hashedPassword,
      role: 'ADM',
    },
  });

  console.log('Created Admin User:', { ...admin, password: '[REDACTED]' });
  console.log('---');
  console.log('Email:', adminEmail);
  console.log('Password: admin123');
  console.log('---');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Failed seeding to the DB:', e);
    await prisma.$disconnect();
    process.exit(1);
  });

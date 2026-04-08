import { env } from './config/env';
import { createApp } from './app';
import prisma from './config/database';
import { stopMonitoring } from './services/monitoring.service';

async function main() {
  // Verify database connection
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }

  const { server } = createApp();

  server.listen(env.PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║        ⚡ CI/CD Orchestrator                 ║
║──────────────────────────────────────────────║
║  Server:     http://localhost:${env.PORT}          ║
║  Frontend:   ${env.FRONTEND_URL}     ║
║  Env:        ${env.NODE_ENV.padEnd(30)}║
╚══════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    stopMonitoring();
    await prisma.$disconnect();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

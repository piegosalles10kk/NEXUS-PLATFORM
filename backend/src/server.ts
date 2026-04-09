import { env } from './config/env';
import { createApp } from './app';
import prisma from './config/database';
import { stopMonitoring } from './services/monitoring.service';
import { runNetworkMonitor, runDailyBillingCron } from './services/scheduler.service';

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

  // ── Background monitors ──────────────────────────────────────────────────
  // Network monitor: transit saturation + Sonar gateway swap every 30 s
  const networkInterval = setInterval(() => runNetworkMonitor(), 30_000);
  // Daily billing consolidation at 00:00 UTC
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10).getTime() - now.getTime();
  setTimeout(() => {
    runDailyBillingCron().catch(console.error);
    setInterval(() => runDailyBillingCron().catch(console.error), 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log('⚡ Sonar + Transit monitor active (30s interval)');
  console.log(`⏰ Daily billing cron scheduled in ${Math.round(msUntilMidnight / 60000)} min`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    clearInterval(networkInterval);
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

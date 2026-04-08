import portscanner from 'portscanner';
import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';

/**
 * Scans a range of ports on the defined host to find available services.
 * @param limit The upper limit of the port range (default: 5000)
 * @param excludePorts List of ports to skip (e.g. database, gateway itself)
 */
export async function discoverAvailablePorts(
  limit: number = 5000,
  excludePorts: number[] = [8000, 27017, 3001, 10000, 4500, 5432, 6379, 5173]
): Promise<number[]> {
  const host = env.PORT_CHECK_HOST || '127.0.0.1';
  const availablePorts: number[] = [];
  
  // Custom range and specific ports as per original project
  const portsToCheck: number[] = [];
  for (let i = 1; i <= limit; i++) {
    if (!excludePorts.includes(i)) {
      portsToCheck.push(i);
    }
  }
  
  // Add specific aaPanel port from original logic
  const ADDITIONAL_PORTS = [19768];
  ADDITIONAL_PORTS.forEach(p => {
    if (!portsToCheck.includes(p) && !excludePorts.includes(p)) {
      portsToCheck.push(p);
    }
  });

  console.log(`🔍 Starting port scan on ${host} for ${portsToCheck.length} ports...`);

  // Sequential scan to avoid OS resource exhaustion
  for (const port of portsToCheck) {
    try {
      const status = await portscanner.checkPortStatus(port, host);
      if (status === 'open') {
        availablePorts.push(port);
      }
    } catch (error) {
      // Just skip failed checks
    }
  }

  try {
    const redis = await getRedisClient();
    await redis.set('gateway:last_scan_result', availablePorts.length.toString());
  } catch (err) {
    console.error('Failed to cache scan result in Redis:', err);
  }

  process.stdout.write(`\r✅ Port scan complete. Found ${availablePorts.length} open ports.\n`);
  return availablePorts;
}

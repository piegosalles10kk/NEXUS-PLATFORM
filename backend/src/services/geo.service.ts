/**
 * geo.service.ts
 *
 * Lightweight IP geolocation using the free ip-api.com endpoint
 * (no API key required, 45 req/min on the free tier).
 *
 * For private/loopback IPs, returns null silently.
 */

interface GeoResult {
  country: string;  // ISO-3166-1 alpha-2, e.g. "BR"
  state:   string;  // Region/state name
  city:    string;
}

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc/,
  /^fd/,
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_RANGES.some(r => r.test(ip));
}

export async function lookupIp(ip: string): Promise<GeoResult | null> {
  if (!ip || isPrivateIp(ip)) return null;

  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.status !== 'success') return null;
    return {
      country: data.countryCode ?? '',
      state:   data.regionName  ?? '',
      city:    data.city        ?? '',
    };
  } catch {
    return null;
  }
}

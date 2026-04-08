/**
 * ca.service.ts
 *
 * Manages the platform's internal CA (Certificate Authority) used to issue
 * mTLS client certificates for registered agents.
 *
 * On first call to ensureCA(), a self-signed CA key + cert is generated via
 * OpenSSL CLI and stored in SystemSettings. Subsequent calls return the cached
 * values. Each agent enrolment generates a unique client key + CSR + cert,
 * all signed by this CA.
 *
 * Requires: openssl CLI available in $PATH (standard in most Linux/Docker envs).
 */
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting, setSetting } from './settings.service';

const CA_KEY_SETTING  = 'INTERNAL_CA_KEY';
const CA_CERT_SETTING = 'INTERNAL_CA_CERT';

let _caCert: string | null = null;
let _caKey:  string | null = null;

/** Returns {caCert, caKey}, generating them once if they don't exist. */
async function ensureCA(): Promise<{ caCert: string; caKey: string }> {
  if (_caCert && _caKey) return { caCert: _caCert, caKey: _caKey };

  const storedCert = await getSetting(CA_CERT_SETTING);
  const storedKey  = await getSetting(CA_KEY_SETTING);

  if (storedCert && storedKey) {
    _caCert = storedCert;
    _caKey  = storedKey;
    return { caCert: storedCert, caKey: storedKey };
  }

  // Generate CA in a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '10kk-ca-'));
  try {
    const caKeyPath  = path.join(tmpDir, 'ca.key');
    const caCertPath = path.join(tmpDir, 'ca.crt');

    execSync(`openssl genrsa -out "${caKeyPath}" 4096`, { stdio: 'pipe' });
    execSync(
      `openssl req -new -x509 -days 3650 -key "${caKeyPath}" -out "${caCertPath}" ` +
      `-subj "/CN=10KK-Platform-CA/O=10KK/C=BR"`,
      { stdio: 'pipe' },
    );

    const caCert = fs.readFileSync(caCertPath, 'utf8');
    const caKey  = fs.readFileSync(caKeyPath,  'utf8');

    await setSetting(CA_CERT_SETTING, caCert);
    await setSetting(CA_KEY_SETTING,  caKey);

    _caCert = caCert;
    _caKey  = caKey;
    return { caCert, caKey };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Issues a client certificate signed by the platform CA.
 * Returns PEM strings for ca_crt, client_crt, client_key.
 */
export async function issueClientCert(
  commonName: string,
): Promise<{ ca_crt: string; client_crt: string; client_key: string }> {
  const { caCert, caKey } = await ensureCA();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '10kk-cert-'));
  try {
    const caKeyPath    = path.join(tmpDir, 'ca.key');
    const caCertPath   = path.join(tmpDir, 'ca.crt');
    const clientKeyPath  = path.join(tmpDir, 'client.key');
    const clientCsrPath  = path.join(tmpDir, 'client.csr');
    const clientCertPath = path.join(tmpDir, 'client.crt');
    const serialPath     = path.join(tmpDir, 'serial');

    fs.writeFileSync(caKeyPath,  caKey);
    fs.writeFileSync(caCertPath, caCert);

    // Unique serial number per certificate
    const serial = crypto.randomBytes(8).toString('hex').toUpperCase();
    fs.writeFileSync(serialPath, serial);

    execSync(`openssl genrsa -out "${clientKeyPath}" 2048`, { stdio: 'pipe' });
    execSync(
      `openssl req -new -key "${clientKeyPath}" -out "${clientCsrPath}" ` +
      `-subj "/CN=${commonName}/O=10KK-Agent/C=BR"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl x509 -req -days 365 ` +
      `-in "${clientCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
      `-set_serial 0x${serial} -out "${clientCertPath}"`,
      { stdio: 'pipe' },
    );

    return {
      ca_crt:     fs.readFileSync(caCertPath,   'utf8'),
      client_crt: fs.readFileSync(clientCertPath, 'utf8'),
      client_key: fs.readFileSync(clientKeyPath,  'utf8'),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Exposes the raw CA cert PEM for use by the mTLS WebSocket server. */
export async function getCACert(): Promise<string> {
  const { caCert } = await ensureCA();
  return caCert;
}

/** Exposes the raw CA key PEM for use by the mTLS WebSocket server. */
export async function getCAKey(): Promise<string> {
  const { caKey } = await ensureCA();
  return caKey;
}

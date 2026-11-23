// Development TLS material for the device listener. The App pins the
// certificate fingerprint, so this is a transport-encryption identity, not a
// public PKI certificate.

import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './build.js';

export async function ensureTlsCertificate(stateDir, { force = false } = {}) {
  const dir = join(stateDir, 'tls');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (force || !existsSync(certPath) || !existsSync(keyPath)) {
    const result = await run('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '365',
      '-subj', '/CN=jiezi-bridge',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new Error(`openssl certificate generation failed: ${result.stderr.slice(-2000)}`);
    }
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o644);
  }
  return {
    certPath,
    keyPath,
    fingerprint: fingerprintOf(readFileSync(certPath, 'utf8')),
  };
}

export function fingerprintOf(certPem) {
  return new X509Certificate(certPem).fingerprint256.replaceAll(':', '').toLowerCase();
}

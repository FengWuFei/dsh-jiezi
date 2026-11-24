// NSH-compatible Ed25519 keys, certificates and the `.jz` outer signature
// (034 plan §4.6).
//
// Key material keeps NSH's file forms: `<name>.secret` and `<name>.pub` are
// base64 of the raw 32-byte seed/public key, `<name>.cert` is
// `{body, signer, signature}`. Signatures cover `context \0 sha256(message)`,
// so a certificate signature can never stand in for a manifest signature.

import { Buffer } from 'node:buffer';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  JZ_SIGNATURE_ALGORITHM,
  JZ_SIGNATURE_CONTEXT,
  JZ_SIGNATURE_FORMAT,
  JZ_SIGNATURE_VERSION,
  jzError,
} from './jz.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CERTIFICATE_CONTEXT = 'nsh-certificate-v1';
const REVOCATIONS_CONTEXT = 'nsh-revocations-v1';
const SIGNATURE_BYTES = 64;
const SIGNATURE_FIELDS = new Set(['format', 'formatVersion', 'algorithm', 'context', 'keyId', 'certificate', 'manifestSha256', 'signature']);
const CERTIFICATE_FIELDS = new Set(['body', 'signer', 'signature']);
const CERT_BODY_FIELDS = new Set(['format', 'key', 'notBefore', 'notAfter', 'apps']);
const REVOCATION_FIELDS = new Set(['body', 'signer', 'signature']);
const REVOCATION_BODY_FIELDS = new Set(['format', 'sequence', 'issuedAt', 'keys', 'packages']);

/** `context \0 sha256(message)` — exactly NSH's framing. */
export function framedMessage(context, message) {
  return Buffer.concat([
    Buffer.from(context, 'utf8'),
    Buffer.from([0]),
    createHash('sha256').update(message).digest(),
  ]);
}

/** Reads a `nsh keygen` private key file (base64 seed) into a KeyObject. */
export function loadSecretKey(path) {
  const text = readTrimmed(path);
  const seed = Buffer.from(text, 'base64');
  if (seed.length !== 32) throw jzError('JZ_BAD_SIGNATURE', `${path} is not a 32-byte Ed25519 seed`);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Reads a raw Ed25519 public key (base64, 32 bytes) into a KeyObject. */
export function publicKeyFromBase64(base64, what = 'public key') {
  const raw = Buffer.from(String(base64).trim(), 'base64');
  if (raw.length !== 32) throw jzError('JZ_UNTRUSTED', `${what} is not a 32-byte Ed25519 key`);
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    throw jzError('JZ_UNTRUSTED', `${what} is not a valid Ed25519 key`);
  }
}

/** NSH key id: first 8 bytes of SHA-256 over the raw key, hex. */
export function keyIdOfBase64(base64) {
  const raw = Buffer.from(String(base64).trim(), 'base64');
  if (raw.length !== 32) throw jzError('JZ_BAD_SIGNATURE', 'key is not 32 bytes');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function keyIdOfKeyObject(keyObject) {
  return keyIdOfBase64(rawPublicBase64(keyObject));
}

function rawPublicBase64(keyObject) {
  const publicKey = keyObject.type === 'private' ? createPublicKey(keyObject) : keyObject;
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Signs manifest bytes and returns the `.jz` signature envelope. */
export function signManifest(manifestBytes, { secretKeyPath, certificatePath, createdAt }) {
  const key = loadSecretKey(secretKeyPath);
  const certificate = readCertificateFile(certificatePath);
  const claimed = openCertificateBody(certificate, { skipRootCheck: true });
  const releaseKeyId = keyIdOfKeyObject(key);
  if (claimed.keyId !== releaseKeyId) {
    throw jzError('JZ_BAD_SIGNATURE', 'the release certificate certifies a different key');
  }
  const signedAt = Math.floor(createdAt.getTime() / 1000);
  if (signedAt < claimed.notBefore || signedAt > claimed.notAfter) {
    throw jzError('JZ_UNTRUSTED', `createdAt is outside the certificate window ${claimed.notBefore}..${claimed.notAfter}`);
  }
  const signature = cryptoSign(null, framedMessage(JZ_SIGNATURE_CONTEXT, manifestBytes), key);
  return {
    format: JZ_SIGNATURE_FORMAT,
    formatVersion: JZ_SIGNATURE_VERSION,
    algorithm: JZ_SIGNATURE_ALGORITHM,
    context: JZ_SIGNATURE_CONTEXT,
    keyId: releaseKeyId,
    certificate,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    signature: Buffer.from(signature).toString('base64'),
  };
}

/**
 * Verifies the outer envelope: exact schema, certificate signed by a trusted
 * root, app scope and signing time, then the manifest signature.
 * @returns {{signerKeyId: string, rootKeyId: string, notAfter: number}}
 */
export function verifyOuterSignature({ envelopeBytes, manifestBytes, appId, createdAt, roots, revocations }) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(envelopeBytes).toString('utf8'));
  } catch {
    throw jzError('JZ_BAD_SIGNATURE', 'signature envelope is not JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature envelope must be an object');
  }
  for (const key of Object.keys(envelope)) {
    if (!SIGNATURE_FIELDS.has(key)) {
      throw jzError('JZ_BAD_SIGNATURE', `signature envelope has the unknown field ${key}`);
    }
  }
  if (envelope.format !== JZ_SIGNATURE_FORMAT) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `signature format must be ${JZ_SIGNATURE_FORMAT}`);
  }
  if (envelope.formatVersion !== JZ_SIGNATURE_VERSION) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `signature formatVersion must be ${JZ_SIGNATURE_VERSION}`);
  }
  if (envelope.algorithm !== JZ_SIGNATURE_ALGORITHM) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `signature algorithm must be ${JZ_SIGNATURE_ALGORITHM}`);
  }
  if (envelope.context !== JZ_SIGNATURE_CONTEXT) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature context does not match the manifest context');
  }
  if (typeof envelope.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.manifestSha256)) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature manifestSha256 is invalid');
  }
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  if (envelope.manifestSha256 !== manifestDigest) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature does not cover this manifest');
  }

  const trusted = normalizeRoots(roots);
  if (trusted.length === 0) throw jzError('JZ_UNTRUSTED', 'no trusted root is configured');

  const certificate = envelope.certificate;
  if (certificate === null || typeof certificate !== 'object' || Array.isArray(certificate)) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature certificate must be an object');
  }
  for (const key of Object.keys(certificate)) {
    if (!CERTIFICATE_FIELDS.has(key)) {
      throw jzError('JZ_BAD_SIGNATURE', `certificate has the unknown field ${key}`);
    }
  }
  const root = trusted.find((candidate) => candidate.id === certificate.signer);
  if (!root) throw jzError('JZ_UNTRUSTED', 'no trusted root signed this release certificate');

  const bodyBytes = decodeBase64(certificate.body, 'certificate body');
  const certificateSignature = decodeBase64(certificate.signature, 'certificate signature');
  const certificateValid = verifyRaw(
    root.key,
    framedMessage(CERTIFICATE_CONTEXT, bodyBytes),
    certificateSignature,
  );
  if (!certificateValid) throw jzError('JZ_UNTRUSTED', 'the release certificate signature does not verify');

  let body;
  try {
    body = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    throw jzError('JZ_BAD_SIGNATURE', 'certificate body is not JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw jzError('JZ_BAD_SIGNATURE', 'certificate body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (!CERT_BODY_FIELDS.has(key)) {
      throw jzError('JZ_BAD_SIGNATURE', `certificate body has the unknown field ${key}`);
    }
  }
  if (body.format !== 1) throw jzError('JZ_UNSUPPORTED_FORMAT', `certificate format ${String(body.format)}`);
  if (typeof body.key !== 'string') throw jzError('JZ_BAD_SIGNATURE', 'certificate body has no key');
  if (!Array.isArray(body.apps) || !body.apps.every((app) => typeof app === 'string')) {
    throw jzError('JZ_BAD_SIGNATURE', 'certificate apps must be an array of strings');
  }
  if (!Number.isSafeInteger(body.notBefore) || !Number.isSafeInteger(body.notAfter)) {
    throw jzError('JZ_BAD_SIGNATURE', 'certificate validity window is invalid');
  }
  const releaseKeyId = keyIdOfBase64(body.key);
  if (envelope.keyId !== releaseKeyId) {
    throw jzError('JZ_BAD_SIGNATURE', 'signature keyId does not match the certified key');
  }
  if (!body.apps.some((pattern) => appMatches(pattern, appId))) {
    throw jzError('JZ_UNTRUSTED', `the certificate does not cover app ${appId}`);
  }
  const signedAt = Math.floor(createdAt.getTime() / 1000);
  if (signedAt < body.notBefore || signedAt > body.notAfter) {
    throw jzError('JZ_UNTRUSTED', `createdAt is outside the certificate window ${body.notBefore}..${body.notAfter}`);
  }

  const signature = decodeBase64(envelope.signature, 'manifest signature');
  const valid = verifyRaw(
    publicKeyFromBase64(body.key, 'release key'),
    framedMessage(JZ_SIGNATURE_CONTEXT, manifestBytes),
    signature,
  );
  if (!valid) throw jzError('JZ_BAD_SIGNATURE', 'the manifest signature does not verify');

  const revoked = revokedEntries(revocations, trusted);
  if (revoked.keys.has(releaseKeyId)) throw jzError('JZ_UNTRUSTED', 'the release key is revoked');

  return { signerKeyId: releaseKeyId, rootKeyId: root.id, notAfter: body.notAfter, revoked };
}

/** App id patterns: `*`, `com.example.*` (a prefix label) or an exact id. */
export function appMatches(pattern, app) {
  if (typeof pattern !== 'string' || typeof app !== 'string') return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return app.length > prefix.length + 1 && app.startsWith(`${prefix}.`);
  }
  return pattern === app;
}

/** Whether a signed revocation list revokes this package or payload digest. */
export function assertNotRevoked(revoked, { packageSha256, payloadSha256 }) {
  if (revoked.packages.has(packageSha256)) throw jzError('JZ_UNTRUSTED', 'this package is revoked');
  if (revoked.packages.has(payloadSha256)) throw jzError('JZ_UNTRUSTED', 'the payload package is revoked');
}

/** Normalizes `--root`/`TrustRoots/*.pub` inputs into `{id, key}` pairs. */
export function normalizeRoots(roots) {
  const result = [];
  for (const root of roots ?? []) {
    if (root === null || root === undefined) continue;
    if (typeof root === 'object' && root.key) {
      // Already normalized by a caller: keep the KeyObject as is.
      const key = typeof root.key === 'string' ? publicKeyFromBase64(root.key, 'trusted root') : root.key;
      result.push({ id: root.id, key });
      continue;
    }
    const base64 = String(root).trim();
    if (base64.length === 0) continue;
    result.push({ id: keyIdOfBase64(base64), key: publicKeyFromBase64(base64, 'trusted root') });
  }
  return result;
}

/**
 * Parses a signed NSH revocation list and returns the revoked key ids and
 * package digests (034 plan D5). The envelope is exactly `{body, signer,
 * signature}` over `"nsh-revocations-v1" \0 SHA-256(body)`, the body is
 * exactly `{format, sequence, issuedAt, keys, packages}`, and the signer must
 * be any configured trusted root (production ∪ development).
 *
 * Supplied revocation data is fail-closed: an unparsable, unsigned,
 * untrusted-root, wrong-context or schema-invalid list refuses the package
 * with `JZ_UNTRUSTED` instead of being silently treated as "nothing revoked".
 * Only a caller that supplied no revocation data skips the check.
 */
export function revokedEntries(signed, roots) {
  const empty = { keys: new Set(), packages: new Set() };
  if (signed === null || signed === undefined) return empty;
  let list;
  if (typeof signed === 'string') {
    try {
      list = JSON.parse(signed);
    } catch {
      throw jzError('JZ_UNTRUSTED', 'the revocation list is not JSON');
    }
  } else {
    list = signed;
  }
  if (list === null || typeof list !== 'object' || Array.isArray(list)) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list must be an object');
  }
  for (const key of Object.keys(list)) {
    if (!REVOCATION_FIELDS.has(key)) {
      throw jzError('JZ_UNTRUSTED', `revocation list has the unknown field ${key}`);
    }
  }
  if (typeof list.signer !== 'string' || list.signer.length === 0) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list has no signer');
  }
  const bodyBytes = decodeRevocationBase64(list.body, 'revocation body');
  const signature = decodeRevocationBase64(list.signature, 'revocation signature');
  const root = (roots ?? []).find((candidate) => candidate.id === list.signer);
  if (!root) throw jzError('JZ_UNTRUSTED', 'no trusted root signed the revocation list');
  if (!verifyRaw(root.key, framedMessage(REVOCATIONS_CONTEXT, bodyBytes), signature)) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list signature does not verify');
  }
  let body;
  try {
    body = JSON.parse(bodyBytes.toString('utf8'));
  } catch {
    throw jzError('JZ_UNTRUSTED', 'the revocation list body is not JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list body must be an object');
  }
  for (const key of Object.keys(body)) {
    if (!REVOCATION_BODY_FIELDS.has(key)) {
      throw jzError('JZ_UNTRUSTED', `revocation list body has the unknown field ${key}`);
    }
  }
  if (body.format !== 1) throw jzError('JZ_UNTRUSTED', `unknown revocation list format ${String(body.format)}`);
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list sequence is invalid');
  }
  if (!Number.isSafeInteger(body.issuedAt) || body.issuedAt < 0) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list issuedAt is invalid');
  }
  if (!isStringArray(body.keys)) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list keys must be an array of strings');
  }
  if (!isStringArray(body.packages)) {
    throw jzError('JZ_UNTRUSTED', 'the revocation list packages must be an array of strings');
  }
  return {
    keys: new Set(body.keys),
    packages: new Set(body.packages.map((value) => value.toLowerCase())),
  };
}

/** Reads and validates a `nsh certify` certificate file. */
export function readCertificateFile(path) {
  const text = readTrimmed(path);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw jzError('JZ_BAD_SIGNATURE', `${path} is not a JSON certificate`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw jzError('JZ_BAD_SIGNATURE', `${path} is not a certificate object`);
  }
  for (const key of Object.keys(parsed)) {
    if (!CERTIFICATE_FIELDS.has(key)) throw jzError('JZ_BAD_SIGNATURE', `certificate has the unknown field ${key}`);
  }
  return { body: parsed.body, signer: parsed.signer, signature: parsed.signature };
}

function openCertificateBody(certificate, { skipRootCheck }) {
  if (!skipRootCheck) throw new Error('root check is not optional here');
  const bodyBytes = decodeBase64(certificate.body, 'certificate body');
  const body = JSON.parse(bodyBytes.toString('utf8'));
  return {
    keyId: keyIdOfBase64(body.key),
    notBefore: body.notBefore,
    notAfter: body.notAfter,
    apps: body.apps,
  };
}

function verifyRaw(publicKey, message, signature) {
  if (signature.length !== SIGNATURE_BYTES) return false;
  try {
    return cryptoVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

function decodeBase64(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw jzError('JZ_BAD_SIGNATURE', `${what} is missing`);
  const data = Buffer.from(value, 'base64');
  if (data.length === 0) throw jzError('JZ_BAD_SIGNATURE', `${what} is empty`);
  if (data.toString('base64') !== value.trim()) throw jzError('JZ_BAD_SIGNATURE', `${what} is not canonical base64`);
  return data;
}

/** Revocation fields are part of the trust decision: fail closed as untrusted. */
function decodeRevocationBase64(value, what) {
  if (typeof value !== 'string' || value.length === 0) throw jzError('JZ_UNTRUSTED', `${what} is missing`);
  const data = Buffer.from(value, 'base64');
  if (data.length === 0) throw jzError('JZ_UNTRUSTED', `${what} is empty`);
  if (data.toString('base64') !== value.trim()) throw jzError('JZ_UNTRUSTED', `${what} is not canonical base64`);
  return data;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readTrimmed(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    throw jzError('JZ_BAD_SIGNATURE', `cannot read key material at ${path}`);
  }
}

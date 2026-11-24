// Shared fixtures for the `.jz` producer/verifier tests. Everything is built
// from raw NSH key/certificate formats so the suite runs without the `nsh`
// binary; tests that need a real toolchain live elsewhere.
import assert from 'node:assert/strict';
import crypto, { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

import {
  JZ_ENTRY,
  JZ_SIGNATURE_ALGORITHM,
  JZ_SIGNATURE_CONTEXT,
  JZ_SIGNATURE_FORMAT,
  JZ_SIGNATURE_VERSION,
  JZError,
} from '../src/jz.js';
import { packPackage, readPackage } from '../src/jz-package.js';
import { readZip as readArchive, writeZip as writeArchive } from '../src/jz-zip.js';

const SECRET_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ---------------------------------------------------------------- lifecycle

const cleanup = [];
process.on('exit', () => {
  for (const dir of cleanup) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

// ---------------------------------------------------------------- crypto

export const FRAMING = (context, message) => Buffer.concat([
  Buffer.from(context),
  Buffer.from([0]),
  createHash('sha256').update(message).digest(),
]);

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    secret: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
}

export function privateKeyObject(pair) {
  return crypto.createPrivateKey({
    key: Buffer.concat([SECRET_PREFIX, pair.secret]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function keyId(pub) {
  return createHash('sha256').update(pub).digest('hex').slice(0, 16);
}

export function writeKeyFiles(dir, name, pair) {
  writeFileSync(join(dir, `${name}.secret`), pair.secret.toString('base64'));
  writeFileSync(join(dir, `${name}.pub`), pair.pub.toString('base64'));
}

export function writeCertificate(dir, root, releasePub, { notBefore, notAfter, apps = ['com.jiezi.*'], signer = null } = {}) {
  const body = Buffer.from(JSON.stringify({
    format: 1,
    key: releasePub.toString('base64'),
    notBefore,
    notAfter,
    apps,
  }));
  const signature = cryptoSign(null, FRAMING('nsh-certificate-v1', body), privateKeyObject(root));
  const certificate = {
    body: body.toString('base64'),
    signer: signer ?? keyId(root.pub),
    signature: Buffer.from(signature).toString('base64'),
  };
  writeFileSync(join(dir, 'release.cert'), JSON.stringify(certificate, null, 2));
  return certificate;
}

/** Signs `body` bytes with a root secret in the `.jz` revocation context. */
export function signBody(root, context, body) {
  return Buffer.from(cryptoSign(null, FRAMING(context, body), privateKeyObject(root)));
}

/**
 * A signed `nsh-revocations-v1` list as the bridge reads it from disk. The
 * body bytes can be replaced to exercise the strict schema; `sign: false`
 * leaves a stale signature.
 */
export function signedRevocations(root, {
  keys = [],
  packages = [],
  sequence = 1,
  issuedAt = Math.floor(Date.now() / 1000),
  format = 1,
  body = null,
  bodyText = null,
  signer = null,
  envelopeFields = null,
  sign = true,
} = {}) {
  const bodyBytes = body ?? Buffer.from(bodyText ?? JSON.stringify({ format, sequence, issuedAt, keys, packages }));
  const envelope = {
    body: bodyBytes.toString('base64'),
    signer: signer ?? keyId(root.pub),
    signature: sign
      ? signBody(root, 'nsh-revocations-v1', bodyBytes).toString('base64')
      : Buffer.alloc(64).toString('base64'),
  };
  if (envelopeFields !== null) Object.assign(envelope, envelopeFields);
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------- media

/** One PNG chunk with a matching CRC. */
export function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1');
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 8 + data.length);
  return chunk;
}

/**
 * A 1024×1024 PNG for producer/reader tests. Defaults are a valid v1 icon;
 * every option injects one specific defect so a negative test can name it.
 */
export function png({
  width = 1024,
  height = 1024,
  colorType = 2,
  bitDepth = 8,
  srgb = true,
  duplicateSrgb = false,
  iccp = false,
  raw = null,
  idat = null,
  idatParts = null,
  betweenIdat = [],
  noIdat = false,
  extraChunks = [],
  trailing = null,
} = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(bitDepth, 8);
  ihdr.writeUInt8(colorType, 9);
  const channels = colorType === 6 ? 4 : 3;
  let scanlines = raw;
  if (scanlines === null) {
    scanlines = Buffer.alloc(height * (1 + width * channels), 0x80);
    for (let row = 0; row < height; row += 1) scanlines[row * (1 + width * channels)] = 0;
  }
  const chunks = [pngChunk('IHDR', ihdr)];
  if (srgb) chunks.push(pngChunk('sRGB', Buffer.from([0])));
  if (duplicateSrgb) chunks.push(pngChunk('sRGB', Buffer.from([0])));
  if (iccp) chunks.push(pngChunk('iCCP', Buffer.from('profile\0\0icc')));
  chunks.push(...extraChunks);
  const parts = idatParts ?? (idat === null ? [deflateSync(scanlines, { level: 1 })] : [idat]);
  parts.forEach((part, index) => {
    if (index > 0) chunks.push(...betweenIdat);
    if (!noIdat) chunks.push(pngChunk('IDAT', part));
  });
  if (noIdat && idatParts === null) chunks.push(...betweenIdat);
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  const body = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
  ]);
  return trailing === null ? body : Buffer.concat([body, trailing]);
}

// ---------------------------------------------------------------- NSH payload

export function nshPayload({ id = 'com.jiezi.miniapp.demo', name = 'Demo', version = '1.0.0', build = 1 } = {}) {
  const header = Buffer.from(JSON.stringify({ app: { id, name, version, build } }));
  const prefix = Buffer.alloc(12);
  prefix.write('NSHP', 0, 'latin1');
  prefix.writeUInt16LE(1, 4);
  prefix.writeUInt16LE(0, 6);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, Buffer.from('payload-bytes')]);
}

// ---------------------------------------------------------------- projects

export function project({
  id = 'com.jiezi.miniapp.demo',
  name = 'Demo',
  version = '1.0.0',
  build = 1,
  withIcon = true,
  icon = null,
  about = '# Demo\n\nHello.\n',
  summary = 'A demo mini app.',
  capabilities = { clipboard: true },
  purposes = { clipboard: 'Read the clipboard only when you tap copy.' },
} = {}) {
  const dir = tempDir('jz-project-');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'nsh.json'), JSON.stringify({
    name, id, version, build, capabilities,
  }));
  writeFileSync(join(dir, 'jiezi.json'), JSON.stringify({
    schemaVersion: 1, summary, capabilityPurposes: purposes,
  }));
  writeFileSync(join(dir, 'docs', 'about.md'), about);
  if (withIcon) {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'icon.png'), icon ?? png());
  }
  const payloadPath = join(dir, 'app.nshpkg');
  writeFileSync(payloadPath, nshPayload({ id, name, version, build }));
  return { dir, payloadPath };
}

export function keys() {
  const dir = tempDir('jz-keys-');
  const root = makeKeyPair();
  const release = makeKeyPair();
  writeKeyFiles(dir, 'root', root);
  writeKeyFiles(dir, 'release', release);
  writeCertificate(dir, root, release.pub, {
    notBefore: Math.floor(Date.now() / 1000) - 3600,
    notAfter: Math.floor(Date.now() / 1000) + 3600,
  });
  return { dir, root, release };
}

export function pack({ key = keys(), fixture = project(), buildNumber = 1, createdAt, minRuntime = '0.6.0' } = {}) {
  const artifactDir = tempDir('jz-artifacts-');
  const result = packPackage({
    projectDir: fixture.dir,
    payloadPath: fixture.payloadPath,
    releaseId: `rel_aaaaaaaaaaaaaaaa_${buildNumber}`,
    buildNumber,
    minRuntime,
    keyDir: key.dir,
    artifactDir,
    ...(createdAt === undefined ? {} : { createdAt }),
  });
  return { result, bytes: readFileSync(result.packagePath), key, fixture, artifactDir };
}


// ---------------------------------------------------------------- assertions

export function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof JZError, `expected JZError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  };
}

export function verify(bytes, key, overrides = {}) {
  return readPackage(bytes, {
    roots: [key.root.pub.toString('base64')],
    route: 'user-file-import',
    ...overrides,
  });
}


// ---------------------------------------------------------------- tampering

/** Rewrites one archive entry, leaving every other byte alone. */
export function withEntry(bytes, name, transform) {
  return writeArchive(readArchive(bytes).map((entry) => (
    entry.name === name ? { name, data: transform(entry.data) } : { name: entry.name, data: entry.data }
  )));
}

export function mutateManifest(bytes, mutate) {
  return withEntry(bytes, JZ_ENTRY.manifest, (data) => {
    const manifest = JSON.parse(data.toString('utf8'));
    mutate(manifest);
    return Buffer.from(JSON.stringify(manifest));
  });
}

export function entryData(bytes, name) {
  const entry = readArchive(bytes).find((candidate) => candidate.name === name);
  return entry === undefined ? null : entry.data;
}

/** Signs manifest bytes exactly as the producer does (`jiezi.miniapp.manifest.v1`). */
export function signManifestEnvelope(key, manifestBytes) {
  const certificate = JSON.parse(readFileSync(join(key.dir, 'release.cert'), 'utf8'));
  return {
    format: JZ_SIGNATURE_FORMAT,
    formatVersion: JZ_SIGNATURE_VERSION,
    algorithm: JZ_SIGNATURE_ALGORITHM,
    context: JZ_SIGNATURE_CONTEXT,
    keyId: keyId(key.release.pub),
    certificate,
    manifestSha256: sha256Hex(manifestBytes),
    signature: cryptoSign(null, FRAMING(JZ_SIGNATURE_CONTEXT, manifestBytes), privateKeyObject(key.release)).toString('base64'),
  };
}

/**
 * Rewrites a package with replaced entries and/or a mutated manifest, then
 * re-signs the manifest so a test isolates *reader field validation* from the
 * signature check (which the producer's own tamper tests cover separately).
 */
export function resignPackage(bytes, key, { replaceEntries = {}, mutateManifest: mutate = null, signatureTransform = null } = {}) {
  const entries = readArchive(bytes).map((entry) => ({
    name: entry.name,
    data: replaceEntries[entry.name] ?? entry.data,
  }));
  const manifestEntry = entries.find((entry) => entry.name === JZ_ENTRY.manifest);
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (mutate !== null) mutate(manifest);
  for (const file of manifest.files ?? []) {
    if (replaceEntries[file.path] === undefined) continue;
    file.byteSize = replaceEntries[file.path].length;
    file.sha256 = sha256Hex(replaceEntries[file.path]);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  manifestEntry.data = manifestBytes;
  const envelope = signManifestEnvelope(key, manifestBytes);
  if (signatureTransform !== null) signatureTransform(envelope);
  entries.find((entry) => entry.name === JZ_ENTRY.signature).data = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return writeArchive(entries);
}

/** Flips one signature byte of an envelope field (`signature` or the certificate's). */
export function flipBase64Byte(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

/**
 * A ZIP container written directly (stored or raw deflate) so a test can
 * declare mismatching sizes/CRC and exercise the reader's own checks. The
 * canonical writer would never produce these.
 */
export function craftedZip(entries) {
  const EOCD = 22;
  const CENTRAL = 46;
  const LOCAL = 30;
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const compressed = entry.compressed ?? data;
    const method = entry.method ?? 0;
    const crc = entry.crc ?? (crc32(data) >>> 0);
    const declaredSize = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(LOCAL);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0014, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const header = Buffer.alloc(CENTRAL);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(0x0014, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(declaredSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += LOCAL + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(EOCD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/** Raw-deflate-compresses `data` for `craftedZip` method-8 entries. */
export function deflate(data) {
  return deflateRawSync(data, { level: 9 });
}

export { readArchive as readZipEntries, writeArchive as writeZipEntries, JZ_ENTRY };

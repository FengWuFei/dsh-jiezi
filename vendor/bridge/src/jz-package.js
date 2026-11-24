// `.jz` v1 package assembly and the shared verification pipeline
// (034 plan §4.3, §4.4, §4.7).
//
// `readPackage` is the one place the checks run, in a fixed order, for every
// route: the bridge's own packed artifact, a file the user selected, a test
// fixture. It takes bytes and never reads a path except through an explicit
// helper, so a caller cannot reorder or skip a step.

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  JZ_ENTRY,
  JZ_EXTENSION,
  JZ_FORMAT,
  JZ_FORMAT_VERSION,
  JZ_LIMITS,
  JZ_SENSITIVE_CAPABILITIES,
  jzError,
} from './jz.js';
import {
  buildManifest,
  validateJieziJSON,
  validateManifest,
  validatePurposes,
} from './jz-manifest.js';
import { readZip, writeZip } from './jz-zip.js';
import { validateDescription, validateIcon } from './jz-media.js';
import {
  appMatches,
  assertNotRevoked,
  keyIdOfBase64,
  normalizeRoots,
  revokedEntries,
  signManifest,
  verifyOuterSignature,
} from './jz-signature.js';

const MAX_NSHP_HEADER = 1024 * 1024;

/**
 * Builds and signs one `.jz` beside the payload it wraps.
 *
 * The producer validates its own output with the reader's rules before it
 * signs, then reads the written archive back through `readPackage` with the
 * build's own root set (034 plan D8). A build can therefore never report
 * success for a package the iOS reader would refuse; on a disagreement the
 * artifact is deleted and the reader's `JZ_*` code is the build failure.
 */
export function packPackage({
  projectDir,
  payloadPath,
  releaseId,
  buildNumber,
  minRuntime,
  keyDir,
  artifactDir,
  createdAt,
  sensitive = JZ_SENSITIVE_CAPABILITIES,
}) {
  const metadata = readJSON(join(projectDir, 'nsh.json'), 'JZ_BAD_MANIFEST', 'nsh.json');
  const presentation = validateJieziJSON(
    readJSON(join(projectDir, 'jiezi.json'), 'JZ_BAD_MANIFEST', 'jiezi.json'),
  );
  const app = {
    id: requireString(metadata.id, 'nsh.json id'),
    name: requireString(metadata.name, 'nsh.json name'),
    version: requireString(metadata.version, 'nsh.json version'),
    build: Number(buildNumber),
  };
  if (!Number.isSafeInteger(app.build) || app.build < 1) {
    throw jzError('JZ_BAD_MANIFEST', 'buildNumber must be a positive integer');
  }
  const packageRuntime = requireString(minRuntime, 'minRuntime');
  const declaration = metadata.capabilities ?? {};
  const purposes = validatePurposes(presentation.capabilityPurposes, declaration, sensitive);

  const payload = readFileSync(payloadPath);
  if (payload.length === 0 || payload.length > JZ_LIMITS.payload) {
    throw jzError('JZ_LIMIT_EXCEEDED', `payload must be 1..${JZ_LIMITS.payload} bytes`);
  }
  const payloadIdentity = readPayloadIdentity(payload);
  if (payloadIdentity.id !== app.id
    || payloadIdentity.name !== app.name
    || payloadIdentity.version !== app.version
    || payloadIdentity.build !== app.build) {
    throw jzError(
      'JZ_PAYLOAD_MISMATCH',
      `payload is ${payloadIdentity.id} ${payloadIdentity.version} (${payloadIdentity.build}), not ${app.id} ${app.version} (${app.build})`,
    );
  }

  const about = readFileSync(join(projectDir, 'docs', 'about.md'));
  validateDescription(about);

  const files = [
    { path: JZ_ENTRY.payload, data: payload },
    { path: JZ_ENTRY.description, data: about },
  ];
  const iconPath = join(projectDir, 'assets', 'icon.png');
  let icon = null;
  if (existsSync(iconPath)) {
    icon = readFileSync(iconPath);
    validateIcon(icon);
    files.push({ path: JZ_ENTRY.icon, data: icon });
  }

  const hashedFiles = files.map((file) => ({
    path: file.path,
    byteSize: file.data.length,
    sha256: sha256Hex(file.data),
  }));
  const manifest = buildManifest({
    app,
    minRuntime: packageRuntime,
    summary: presentation.summary,
    purposes,
    declaration,
    files: hashedFiles,
    createdAt: (createdAt ?? new Date()).toISOString(),
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  // Reader-rule pre-validation: schema, identity, minRuntime, createdAt, text,
  // capability shapes and purposes. The archive writer is deterministic, so
  // validating these declared entries is the same check `readPackage` makes.
  validateManifest(manifest, [
    ...files.map((file) => ({ name: file.path, data: file.data })),
    { name: JZ_ENTRY.manifest, data: manifestBytes },
  ]);
  validatePurposes(manifest.capabilities.purposes, manifest.capabilities.declaration, sensitive);
  if (manifestBytes.length > JZ_LIMITS.manifest) {
    throw jzError('JZ_LIMIT_EXCEEDED', 'manifest exceeds its v1 bound');
  }

  const envelope = signManifest(manifestBytes, {
    secretKeyPath: join(keyDir, 'release.secret'),
    certificatePath: join(keyDir, 'release.cert'),
    createdAt: new Date(manifest.createdAt),
  });
  const certificateBody = JSON.parse(
    Buffer.from(envelope.certificate.body, 'base64').toString('utf8'),
  );
  if (!Array.isArray(certificateBody.apps)
    || !certificateBody.apps.some((pattern) => appMatches(pattern, app.id))) {
    throw jzError('JZ_UNTRUSTED', `the release certificate does not cover app ${app.id}`);
  }
  const signatureBytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  if (signatureBytes.length > JZ_LIMITS.signature) {
    throw jzError('JZ_LIMIT_EXCEEDED', 'signature envelope exceeds its v1 bound');
  }

  const zipEntries = [
    ...files.map((file) => ({ name: file.path, data: file.data })),
    { name: JZ_ENTRY.manifest, data: manifestBytes },
    { name: JZ_ENTRY.signature, data: signatureBytes },
  ];
  const packageBytes = writeZip(zipEntries);
  if (packageBytes.length > JZ_LIMITS.package) {
    throw jzError('JZ_LIMIT_EXCEEDED', 'package exceeds its v1 bound');
  }

  const artifactPath = join(artifactDir, `${releaseId}${JZ_EXTENSION}`);
  writeFileAtomically(artifactPath, packageBytes);

  // Read the exact bytes back with the build's own trust root. This is the
  // producer's proof that the artifact it reports is installable; a reader
  // refusal deletes the artifact and becomes the build's failure code.
  try {
    const verified = readPackage(packageBytes, {
      roots: [readRootPublicKey(keyDir)],
      route: 'paired-developer',
      sensitive,
    });
    for (const [what, expected, actual] of [
      ['package digest', sha256Hex(packageBytes), verified.packageSha256],
      ['manifest digest', sha256Hex(manifestBytes), verified.manifestSha256],
      ['payload digest', sha256Hex(payload), verified.payloadSha256],
      ['app id', app.id, verified.manifest.app.id],
      ['app name', app.name, verified.manifest.app.name],
      ['app version', app.version, verified.manifest.app.version],
      ['app build', app.build, verified.manifest.app.build],
      ['minRuntime', packageRuntime, verified.manifest.runtime.minRuntime],
    ]) {
      if (expected !== actual) {
        throw jzError('JZ_UNTRUSTED', `read-back ${what} is ${String(actual)}, not ${String(expected)}`);
      }
    }
  } catch (error) {
    removeIfExists(artifactPath);
    throw error;
  }

  return {
    ok: true,
    format: JZ_FORMAT,
    formatVersion: JZ_FORMAT_VERSION,
    releaseId,
    packagePath: artifactPath,
    packageSha256: sha256Hex(packageBytes),
    packageByteSize: packageBytes.length,
    manifestSha256: sha256Hex(manifestBytes),
    payloadSha256: sha256Hex(payload),
    payloadByteSize: payload.length,
    summary: manifest.presentation.summary,
    iconSha256: icon === null ? null : sha256Hex(icon),
    descriptionSha256: sha256Hex(about),
    capabilities: declaration,
    purposes,
    appId: app.id,
    name: app.name,
    version: app.version,
    build: app.build,
    minRuntime: packageRuntime,
    signerKeyId: envelope.keyId,
    rootKeyId: envelope.certificate.signer,
    createdAt: manifest.createdAt,
  };
}

/** Writes `bytes` to `path` with fsync before the atomic rename. */
function writeFileAtomically(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    removeIfExists(temporary);
    throw error;
  }
}

/** Best-effort directory fsync so the rename itself survives a crash. */
function syncDirectory(directory) {
  try {
    const fd = openSync(directory, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every platform; the file fsync and
    // the atomic rename are the durability contract that matters.
  }
}

function removeIfExists(path) {
  try {
    unlinkSync(path);
  } catch {
    // Removal is best effort; the original failure is what the caller sees.
  }
}

/** The build's own trust root, read from `<keyDir>/root.pub`. */
function readRootPublicKey(keyDir) {
  let key;
  try {
    key = String(readFileSync(join(keyDir, 'root.pub'), 'utf8')).trim();
  } catch {
    throw jzError('JZ_UNTRUSTED', 'the build has no readable trust root to re-verify its own package');
  }
  if (Buffer.from(key, 'base64').length !== 32) {
    throw jzError('JZ_UNTRUSTED', 'the build trust root is not a 32-byte Ed25519 key');
  }
  return key;
}

/**
 * The full outer pipeline. `options.route` only selects the trusted roots:
 * `'paired-developer'` may include the development root, `'user-file-import'`
 * must not, and a development-root package offered to file import is refused
 * with `JZ_DEVELOPMENT_IMPORT`.
 * @returns {{
 *   manifest: object, payload: Buffer, icon: Buffer|null, description: string,
 *   packageSha256: string, manifestSha256: string, payloadSha256: string,
 *   signerKeyId: string, rootKeyId: string, trust: 'production'|'development'
 * }}
 */
export function readPackage(bytes, {
  roots = [],
  developmentRoots = [],
  route = 'user-file-import',
  revocations = null,
  sensitive = JZ_SENSITIVE_CAPABILITIES,
} = {}) {
  if (!Buffer.isBuffer(bytes)) throw jzError('JZ_BAD_ARCHIVE', 'package is not a buffer');
  if (bytes.length > JZ_LIMITS.package) {
    throw jzError('JZ_LIMIT_EXCEEDED', `package exceeds ${JZ_LIMITS.package} bytes`);
  }

  // 1. Container.
  const entries = readZip(bytes);
  const entryByName = new Map(entries.map((entry) => [entry.name, entry.data]));
  for (const required of [JZ_ENTRY.manifest, JZ_ENTRY.payload, JZ_ENTRY.description, JZ_ENTRY.signature]) {
    if (!entryByName.has(required)) throw jzError('JZ_UNKNOWN_ENTRY', `package is missing ${required}`);
  }

  // 2. Manifest schema and bounds.
  const manifestBytes = entryByName.get(JZ_ENTRY.manifest);
  let rawManifest;
  try {
    rawManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw jzError('JZ_BAD_MANIFEST', 'manifest is not JSON');
  }
  const manifest = validateManifest(rawManifest, entries);

  // 3. Per-file hashes.
  const payload = entryByName.get(JZ_ENTRY.payload);
  const descriptionBytes = entryByName.get(JZ_ENTRY.description);
  const iconBytes = entryByName.get(JZ_ENTRY.icon) ?? null;
  for (const file of manifest.files) {
    const data = entryByName.get(file.path);
    if (data === undefined) throw jzError('JZ_BAD_MANIFEST', `manifest lists ${file.path}, which the package does not contain`);
    if (data.length !== file.byteSize) {
      throw jzError('JZ_HASH_MISMATCH', `${file.path} is ${data.length} bytes, not ${file.byteSize}`);
    }
    if (sha256Hex(data) !== file.sha256) {
      throw jzError('JZ_HASH_MISMATCH', `${file.path} does not match its manifest hash`);
    }
  }

  // 4. Media and text.
  const icon = iconBytes === null ? null : (validateIcon(iconBytes), iconBytes);
  const description = validateDescription(descriptionBytes);

  // 5. Capability purposes (display data; never a grant).
  const purposes = validatePurposes(manifest.capabilities.purposes, manifest.capabilities.declaration, sensitive);
  if (Object.keys(purposes).length !== Object.keys(manifest.capabilities.purposes).length) {
    throw jzError('JZ_UNKNOWN_PURPOSE', 'manifest purposes do not match the declaration');
  }

  // 6. Signature, certificate, revocation.
  // Development roots identify a signer on every route; only the paired
  // developer route authorizes one. That is what turns a development-signed
  // file import into an explicit JZ_DEVELOPMENT_IMPORT instead of a generic
  // "untrusted" refusal.
  const production = normalizeRoots(roots);
  const development = normalizeRoots(developmentRoots);
  const candidates = [...production, ...development];
  const verified = verifyOuterSignature({
    envelopeBytes: entryByName.get(JZ_ENTRY.signature),
    manifestBytes,
    appId: manifest.app.id,
    createdAt: manifest.createdAt,
    roots: candidates,
    revocations,
  });
  const trust = production.some((root) => root.id === verified.rootKeyId) ? 'production' : 'development';
  if (trust === 'development' && route !== 'paired-developer') {
    throw jzError('JZ_DEVELOPMENT_IMPORT', 'a development-signed package cannot be imported from a file');
  }
  assertNotRevoked(verified.revoked, {
    packageSha256: sha256Hex(bytes),
    payloadSha256: sha256Hex(payload),
  });
  // D4: readers do not re-refuse a package because the current time is past
  // the certificate's notAfter. Only the signing time (`createdAt`) must fall
  // inside the certificate window, which `verifyOuterSignature` already
  // checked; plan §4.6 item 2 and NSH both work that way.

  // 7. Payload identity pre-flight. NshPackage.Info on the device stays
  // authoritative; this refuses the obvious mismatch before any install work.
  const identity = readPayloadIdentity(payload);
  if (identity.id !== manifest.app.id
    || identity.name !== manifest.app.name
    || identity.version !== manifest.app.version
    || identity.build !== manifest.app.build) {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload identity does not match the manifest');
  }

  return {
    manifest,
    payload,
    icon,
    description,
    packageSha256: sha256Hex(bytes),
    manifestSha256: sha256Hex(manifestBytes),
    payloadSha256: sha256Hex(payload),
    payloadByteSize: payload.length,
    signerKeyId: verified.signerKeyId,
    rootKeyId: verified.rootKeyId,
    trust,
  };
}

/**
 * Reads a `.jz` file with the size cap applied to the opened file before the
 * bytes are read (034 plan §4.3: a reader stops at the first exceeded bound
 * and does not allocate from the declared size). The extra byte read detects a
 * file that grows between `fstat` and the read.
 */
export function verifyPackageFile(path, options = {}) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw jzError('JZ_BAD_ARCHIVE', 'package path is not a regular file');
    if (stat.size > JZ_LIMITS.package) {
      throw jzError('JZ_LIMIT_EXCEEDED', `package exceeds ${JZ_LIMITS.package} bytes`);
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return readPackage(buffer.subarray(0, offset), options);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the identity of a `.nshpkg` payload from its documented framing
 * (`NSHP`, version, flags, header length, JSON header). The values are
 * unverified; callers use them only for a pre-flight comparison.
 */
export function readPayloadIdentity(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 12) {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload is too short to be an NSH package');
  }
  if (payload.toString('latin1', 0, 4) !== 'NSHP') {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload does not begin with the NSHP magic');
  }
  const length = payload.readUInt32LE(8);
  if (length === 0 || length > MAX_NSHP_HEADER || 12 + length > payload.length) {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload header length is out of range');
  }
  let header;
  try {
    header = JSON.parse(payload.toString('utf8', 12, 12 + length));
  } catch {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload header is not JSON');
  }
  if (header === null || typeof header !== 'object' || header.app === null || typeof header.app !== 'object') {
    throw jzError('JZ_PAYLOAD_MISMATCH', 'payload header has no app identity');
  }
  const build = Number(header.app.build);
  return {
    id: String(header.app.id ?? ''),
    name: String(header.app.name ?? ''),
    version: String(header.app.version ?? ''),
    build: Number.isSafeInteger(build) ? build : -1,
  };
}

/** SHA-256 hex of a buffer. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Key id for a base64 root public key (for diagnostics and tests). */
export function rootKeyId(base64) {
  return keyIdOfBase64(base64);
}

/** Loads the roots a route may trust. Production roots always count. */
export function trustedRootsForRoute({ rootDir, developmentKeyDir }, route) {
  const roots = [];
  if (rootDir && existsSync(join(rootDir, 'root.pub'))) {
    roots.push(String(readFileSync(join(rootDir, 'root.pub'), 'utf8')).trim());
  }
  const developmentRoots = [];
  if (route === 'paired-developer' && developmentKeyDir && existsSync(join(developmentKeyDir, 'root.pub'))) {
    developmentRoots.push(String(readFileSync(join(developmentKeyDir, 'root.pub'), 'utf8')).trim());
  }
  return { roots, developmentRoots };
}

/** Reads a revocation list file, if one exists. */
export function loadRevocations(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJSON(path, code, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw jzError(code, `${what} cannot be read: ${error.message}`);
  }
}

function requireString(value, what) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw jzError('JZ_BAD_MANIFEST', `${what} must be a non-empty string`);
  }
  return value;
}

export { revokedEntries };

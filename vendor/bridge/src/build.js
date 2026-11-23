// Pinned Native Shell build runner. The Agent never receives a signing key:
// this module is only executed inside the bridge process.

import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parseBuildErrors, ProtocolError } from './protocol.js';

const IGNORED_DIRS = new Set(['.git', '.build', '.nsh', 'node_modules']);
const MAX_CAPTURE = 64 * 1024;

/**
 * App-id patterns the bridge's development certificate covers. The pinned
 * `nsh certify` call uses this exact list, and project initialization reports
 * it so an app id outside the scope fails before a build rather than at signing.
 */
export const DEV_CERT_APPS = 'com.jiezi.*';

/** Immutable release identity: source revision plus the monotonic build number. */
export function releaseIdFor(sourceHash, buildNumber) {
  return `rel_${String(sourceHash).slice(0, 16)}_${Number(buildNumber)}`;
}

const NSH_BINARY = process.platform === 'win32' ? 'nsh.exe' : 'nsh';
const NSH_PACKAGE_PREFIX = '@local/jiezi-nsh';

/**
 * The NSH CLI installed as the plugin's optional platform dependency. A
 * missing optional install is normal and falls back to the external paths.
 * @returns the resolved executable path, or null when this platform has no
 * packaged toolchain.
 */
export function bundledNshPath() {
  const packageName = `${NSH_PACKAGE_PREFIX}-${process.platform}-${process.arch}`;
  try {
    return createRequire(import.meta.url).resolve(`${packageName}/bin/${NSH_BINARY}`);
  } catch {
    return null;
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every nsh location the bridge checks, most specific first. A configured or
 * environment path still wins over discovery so an explicit choice is honored.
 */
export function nshCandidates(explicit) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const path = resolve(value);
    if (!candidates.includes(path)) candidates.push(path);
  };
  add(explicit);
  add(process.env.NSH_TOOLCHAIN);
  add(bundledNshPath());
  add(join(homedir(), '.jiezi', 'tooling', 'nsh', 'bin', NSH_BINARY));
  add(join(homedir(), 'Desktop', 'native-shell-demo', '.tooling', 'nsh', 'bin', NSH_BINARY));
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length > 0) add(join(directory, NSH_BINARY));
  }
  return candidates;
}

/** First executable candidate, or null when none exists. */
export function discoverNsh(explicit) {
  return nshCandidates(explicit).find(isExecutable) ?? null;
}

export function defaultNshPath() {
  return discoverNsh() ?? nshCandidates()[0];
}

export function resolveNsh(explicit) {
  const found = discoverNsh(explicit);
  if (found === null) {
    throw new ProtocolError(
      'build_failed',
      `nsh is not executable; checked ${nshCandidates(explicit).slice(0, 8).join(', ')}. Pass --nsh or set NSH_TOOLCHAIN`,
    );
  }
  return found;
}

export async function nshVersion(nshPath) {
  const result = await run(nshPath, ['--version'], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new ProtocolError('build_failed', `nsh --version failed: ${tail(result.stderr)}`);
  }
  return result.stdout.trim();
}

export async function ensureDevKey(nshPath, keyDir, apps = DEV_CERT_APPS) {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const rootSecret = join(keyDir, 'root.secret');
  const releaseSecret = join(keyDir, 'release.secret');
  const releasePublic = join(keyDir, 'release.pub');
  const releaseCert = join(keyDir, 'release.cert');
  const rootPublic = join(keyDir, 'root.pub');

  let keyId = null;
  if (!existsSync(rootSecret)) {
    const result = await run(nshPath, ['keygen', join(keyDir, 'root')], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new ProtocolError('build_failed', `nsh keygen root failed: ${tail(result.stderr)}`);
  }
  if (!existsSync(releaseSecret)) {
    const result = await run(nshPath, ['keygen', join(keyDir, 'release')], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new ProtocolError('build_failed', `nsh keygen release failed: ${tail(result.stderr)}`);
    const match = `${result.stderr}\n${result.stdout}`.match(/key ([0-9a-f]+):/);
    if (match) keyId = match[1];
  }
  if (keyId === null) keyId = keyIdFromSecret(releaseSecret);
  if (!existsSync(releaseCert)) {
    const result = await run(
      nshPath,
      ['certify', '--root', rootSecret, '--key', releasePublic, '--apps', apps, '-o', releaseCert],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) throw new ProtocolError('build_failed', `nsh certify failed: ${tail(result.stderr)}`);
  }
  return { key: releaseSecret, cert: releaseCert, rootPublic, keyId };
}

function keyIdFromSecret(path) {
  try {
    const bytes = readFileSync(path);
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

export function sourceHash(projectDir) {
  const files = [];
  walk(projectDir, projectDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path);
    digest.update('\u0000');
    digest.update(file.hash);
    digest.update('\n');
  }
  return { hash: digest.digest('hex'), files: files.length };
}

function walk(root, dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ProtocolError('outside_project_root', `project contains a symlink: ${relative(root, absolute)}`);
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const data = readFileSync(absolute);
    files.push({
      path: relative(root, absolute).split('\\').join('/'),
      hash: createHash('sha256').update(data).digest('hex'),
    });
  }
}

export function readProjectMetadata(projectDir) {
  const nshJson = join(projectDir, 'nsh.json');
  if (!existsSync(nshJson)) return {};
  try {
    const value = JSON.parse(readFileSync(nshJson, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function buildProject({ projectDir, projectId, nshPath, keyDir, artifactDir, buildNumber, minRuntime, requireSigned }) {
  const metadata = readProjectMetadata(projectDir);
  const { hash } = sourceHash(projectDir);
  const releaseId = releaseIdFor(hash, buildNumber);

  let key = null;
  if (keyDir) key = await ensureDevKey(nshPath, keyDir);
  if (requireSigned && !key) {
    throw new ProtocolError('build_failed', 'signed delivery is required but no development key is configured');
  }

  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(artifactDir, `${releaseId}.nshpkg`);
  const tmpArtifact = `${artifactPath}.tmp-${process.pid}`;
  const unsignedDir = `${artifactPath}.unsigned`;

  const args = key
    ? [
        'publish',
        projectDir,
        '--key', key.key,
        '--cert', key.cert,
        '--build', String(buildNumber),
        '-o', tmpArtifact,
        ...(minRuntime ? ['--min-runtime', minRuntime] : []),
      ]
    : ['build', projectDir, '--release', '--out', unsignedDir];

  const result = await run(nshPath, args, { timeoutMs: 180_000 });
  if (result.code !== 0) {
    const canonicalProjectDir = realpathSync(projectDir);
    const errors = parseBuildErrors(`${result.stderr}\n${result.stdout}`, metadata.entry ?? 'App.tsx')
      .map((error) => ({
        ...error,
        file: isAbsolute(error.file) ? relative(canonicalProjectDir, error.file) : error.file,
      }));
    // No artifact and no release metadata were written. Returning the attempted
    // release id or `signed: true` here made callers believe a deployable
    // signed release existed (018 plan §4.5).
    return {
      ok: false,
      releaseId: null,
      build: buildNumber,
      stage: 'compile',
      signed: false,
      signedRequested: Boolean(key),
      errors: errors.length > 0
        ? errors
        : [{ file: metadata.entry ?? 'App.tsx', line: 0, column: 0, message: tail(result.stderr) || 'nsh build failed' }],
      rawTail: tail(result.stderr),
    };
  }

  if (!key) {
    return {
      ok: true,
      releaseId,
      build: buildNumber,
      signed: false,
      artifactPath: unsignedDir,
      sha256: null,
      minRuntime: minRuntime ?? null,
      stdout: tail(result.stdout),
    };
  }

  renameSync(tmpArtifact, artifactPath);
  const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  const stdouts = result.stdout;
  const keyMatch = stdouts.match(/signed by ([0-9a-f]+)/);
  const runtimeMatch = stdouts.match(/for runtime ([^ ]+) or newer/);
  const record = {
    releaseId,
    projectId,
    build: buildNumber,
    signed: true,
    keyId: keyMatch?.[1] ?? key.keyId,
    sha256,
    artifactPath,
    minRuntime: runtimeMatch?.[1] ?? minRuntime ?? null,
    name: metadata.name ?? projectId,
    appId: metadata.id ?? null,
    createdAt: new Date().toISOString(),
    nsh: nshPath,
    sourceHash: hash,
  };
  writeFileSync(`${artifactPath}.json`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, ...record };
}

export function run(command, args, { timeoutMs = 60_000, cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    const collect = (target, chunk) => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = boundedAppend(stdout, text);
      else stderr = boundedAppend(stderr, text);
    };
    child.stdout.on('data', (chunk) => collect('out', chunk));
    child.stderr.on('data', (chunk) => collect('err', chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ProtocolError('timeout', `${basename(command)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function boundedAppend(current, addition) {
  const next = current + addition;
  return next.length <= MAX_CAPTURE ? next : next.slice(-MAX_CAPTURE);
}

function tail(value) {
  const text = String(value ?? '').trim();
  return text.length <= 4000 ? text : text.slice(-4000);
}

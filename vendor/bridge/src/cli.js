#!/usr/bin/env node
// jiezi-bridge command line: init, serve, pair-code, build, status, doctor.

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bridge } from './bridge.js';
import { buildProject, ensureDevKey, resolveNsh, nshVersion } from './build.js';
import { doctorFix, doctorReport } from './doctor.js';
import { Store, ensureDir } from './store.js';
import { PAIR_CODE_TTL_MS } from './protocol.js';
import { ensureTlsCertificate } from './tls.js';

const DEFAULT_STATE = join(homedir(), '.jiezi');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function stateDirOf(args) {
  return resolve(String(args['state-dir'] ?? process.env.JIEZI_HOME ?? DEFAULT_STATE));
}

/** Trust-root paths from `--trust-root` (path-list separated) or the config. */
function trustRootPathsFor(args, existing) {
  const value = args['trust-root'];
  if (value === undefined) return existing.trustRootPaths ?? [];
  if (typeof value !== 'string') throw new Error('--trust-root needs a file path');
  return value
    .split(delimiter)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => resolve(path));
}

/**
 * Production trust configuration for `.jz` verification. `trustRootPaths` and
 * `revocationsPath` are consumed by `Bridge.productionRoots()` and
 * `Bridge.revocations()`; before this they were read but nothing ever set
 * them (034 plan A.12).
 */
export function configFor(args, store) {
  const existing = store.loadConfig() ?? {};
  const projectRoot = resolve(String(args['project-root'] ?? existing.projectRoot ?? join(store.root, 'projects')));
  const socketPath = resolve(String(args.socket ?? existing.socketPath ?? store.paths.socket));
  const nshPath = resolveNsh(args.nsh ?? existing.nshPath);
  const port = Number(args.port ?? existing.port ?? 7331);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer from 0 to 65535');
  return {
    ...existing,
    stateDir: store.root,
    socketPath,
    host: String(args.host ?? existing.host ?? '127.0.0.1'),
    port,
    projectRoot,
    nshPath,
    devKeyDir: resolve(String(args['dev-keys'] ?? existing.devKeyDir ?? store.paths.keys)),
    requireSigned: args['require-signed'] === undefined
      ? existing.requireSigned ?? true
      : args['require-signed'] !== 'false',
    minRuntime: String(args['min-runtime'] ?? existing.minRuntime ?? '0.6.0'),
    tlsCert: args['tls-cert'] ?? existing.tlsCert ?? null,
    tlsKey: args['tls-key'] ?? existing.tlsKey ?? null,
    tlsFingerprint: existing.tlsFingerprint ?? null,
    shareRootPublicKey: existing.shareRootPublicKey ?? true,
    trustRootPaths: trustRootPathsFor(args, existing),
    revocationsPath: args.revocations === undefined
      ? existing.revocationsPath ?? null
      : typeof args.revocations !== 'string' || args.revocations.length === 0
        ? null
        : resolve(String(args.revocations)),
  };
}

export async function init(args = parseArgs(process.argv.slice(2))) {
  const store = new Store(stateDirOf(args));
  ensureDir(store.paths.projects);
  const config = configFor(args, store);
  const version = await nshVersion(config.nshPath);
  let key = null;
  if (args['dev-key']) {
    key = await ensureDevKey(config.nshPath, config.devKeyDir);
  }
  if (args.tls) {
    const tls = await ensureTlsCertificate(store.root, { force: args['tls-force'] === true });
    config.tlsCert = tls.certPath;
    config.tlsKey = tls.keyPath;
    config.tlsFingerprint = tls.fingerprint;
  }
  store.saveConfig(config);
  return {
    ok: true,
    stateDir: store.root,
    socket: config.socketPath,
    projectRoot: config.projectRoot,
    nsh: config.nshPath,
    nshVersion: version,
    devKey: key ? { keyId: key.keyId, path: config.devKeyDir } : null,
    requireSigned: config.requireSigned,
    tls: config.tlsCert ? { cert: config.tlsCert, fingerprint: config.tlsFingerprint } : null,
  };
}

export function pairCode(args = parseArgs(process.argv.slice(2))) {
  const store = new Store(stateDirOf(args));
  let code = '';
  for (let i = 0; i < 8; i += 1) code += ALPHABET[randomBytes(1)[0] % ALPHABET.length];
  store.setPairCode(code, PAIR_CODE_TTL_MS);
  const current = store.readPairCode();
  return { ok: true, code, expiresAt: current.expiresAt };
}

export function status(args = parseArgs(process.argv.slice(2))) {
  const store = new Store(stateDirOf(args));
  const config = store.loadConfig() ?? {};
  return {
    ok: true,
    stateDir: store.root,
    config,
    tlsFingerprint: config.tlsFingerprint ?? null,
    devices: store.listDevices(),
    ops: store.listOps().slice(0, 20),
  };
}

export async function doctor(args = parseArgs(process.argv.slice(2))) {
  return args.fix === true ? doctorFix(args) : doctorReport(args);
}

export async function build(args = parseArgs(process.argv.slice(2))) {
  const store = new Store(stateDirOf(args));
  const config = configFor(args, store);
  const projectId = String(args.project ?? args._[0] ?? '');
  if (!projectId) throw new Error('usage: jiezi-bridge build --project <projectId>');
  const projectDir = resolve(String(args['project-dir'] ?? join(config.projectRoot, projectId)));
  const buildNumber = store.reserveBuild(projectId);
  return buildProject({
    projectDir,
    projectId,
    nshPath: config.nshPath,
    keyDir: config.devKeyDir,
    artifactDir: store.paths.artifacts,
    buildNumber,
    minRuntime: config.minRuntime,
    requireSigned: config.requireSigned,
  });
}

export async function serve(args = parseArgs(process.argv.slice(2))) {
  const store = new Store(stateDirOf(args));
  const existing = store.loadConfig();
  if (!existing) throw new Error(`no bridge config at ${store.paths.config}; run init first`);
  const config = configFor(args, store);
  const bridge = new Bridge({
    store,
    config,
    log: (message) => process.stderr.write(`[jiezi-bridge] ${message}\n`),
  });
  const info = await bridge.start();
  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { ...info, bridge };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === 'init') return init(args);
  if (command === 'pair-code') return pairCode(args);
  if (command === 'status') return status(args);
  if (command === 'doctor') return doctor(args);
  if (command === 'build') return build(args);
  if (command === 'serve') {
    const info = await serve(args);
    console.log(JSON.stringify({
      ok: true,
      version: info.version,
      socket: info.socket,
      deviceUrl: info.deviceUrl,
      artifactBase: info.artifactBase,
      projectRoot: info.projectRoot,
      pid: info.pid,
    }));
    return null;
  }
  throw new Error('usage: jiezi-bridge <init|serve|pair-code|build|status|doctor> [options]');
}

/**
 * Compare real paths, not the argv string: a package installed behind a
 * symlink (or invoked through macOS `/tmp`) must still run its CLI main.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((result) => {
      if (result === null) return;
      if (result && result.bridge) delete result.bridge;
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'error', message: error.message } }));
      process.exit(1);
    });
}

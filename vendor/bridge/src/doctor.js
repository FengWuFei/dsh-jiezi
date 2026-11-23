// Read-only environment report behind `jiezi-bridge doctor` and the DSH setup
// panel. It never creates trust material and never throws for a missing nsh or
// an uninitialized state directory; every failure becomes a check row.

import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNsh, nshCandidates, nshVersion, run } from './build.js';
import { installIdentity } from './identity.js';
import { writeJsonAtomic } from './store.js';
import { VERSION } from './version.js';

const DEFAULT_STATE = join(homedir(), '.jiezi');
const MAX_CANDIDATES = 12;
const MAX_HEALTH_BYTES = 64 * 1024;

function readConfig(stateDir) {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function keysPresent(keysDir) {
  try {
    return readdirSync(keysDir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

function probeHealth(socketPath) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let request;
    try {
      request = httpRequest({
        socketPath,
        path: '/v1/health',
        method: 'GET',
        headers: { accept: 'application/json' },
      }, (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_HEALTH_BYTES) {
            request.destroy();
            finish({ ok: false, version: null, error: 'health response exceeded 64 KiB' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish({
              ok: (response.statusCode ?? 0) === 200 && body?.ok === true,
              version: typeof body?.version === 'string' ? body.version : null,
              startedAt: typeof body?.startedAt === 'string' ? body.startedAt : null,
              nsh: typeof body?.nsh === 'string' ? body.nsh : null,
              install: body?.install !== null && typeof body?.install === 'object' && !Array.isArray(body.install)
                ? body.install
                : null,
              error: null,
            });
          } catch {
            finish({ ok: false, version: null, error: 'health response was not JSON' });
          }
        });
        response.on('error', (error) => finish({ ok: false, version: null, error: error.message }));
      });
    } catch (error) {
      finish({ ok: false, version: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    request.setTimeout(1_500, () => {
      request.destroy();
      finish({ ok: false, version: null, error: 'health probe timed out' });
    });
    request.on('error', (error) => finish({ ok: false, version: null, error: error.code ?? error.message }));
    request.end();
  });
}

async function appleTools() {
  if (process.platform !== 'darwin') {
    return { devicectl: false, simctl: false, note: 'Apple device tooling is available on macOS only.' };
  }
  const find = async (name) => {
    try {
      const result = await run('xcrun', ['--find', name], { timeoutMs: 4_000 });
      return result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  };
  const [devicectl, simctl] = await Promise.all([find('devicectl'), find('simctl')]);
  return {
    devicectl,
    simctl,
    note: devicectl || simctl ? null : 'Xcode command-line tools were not found.',
  };
}

function check(id, ok, message) {
  return { id, ok, message };
}

/**
 * Inspect the bridge environment without mutating it.
 * @param args - parsed CLI args; `--state-dir` and `--nsh` are honored.
 * @returns a bounded JSON-serializable report; `ok` is always true.
 */
export async function doctorReport(args = {}) {
  const stateDir = resolve(String(args['state-dir'] ?? process.env.JIEZI_HOME ?? DEFAULT_STATE));
  const config = readConfig(stateDir);
  const configuredNsh = typeof args.nsh === 'string' ? args.nsh : config?.nshPath;
  const socketPath = typeof config?.socketPath === 'string'
    ? resolve(config.socketPath)
    : join(stateDir, 'bridge.sock');
  const keysDir = typeof config?.devKeyDir === 'string'
    ? resolve(config.devKeyDir)
    : join(stateDir, 'dev-keys');

  const candidates = nshCandidates(configuredNsh);
  const nshPath = discoverNsh(configuredNsh);
  const identity = installIdentity();
  let nshReportedVersion = null;
  let nshError = nshPath === null ? 'nsh was not found in any known location' : null;
  if (nshPath !== null) {
    try {
      nshReportedVersion = await nshVersion(nshPath);
    } catch (error) {
      nshError = error instanceof Error ? error.message : String(error);
    }
  }

  const [health, apple] = await Promise.all([probeHealth(socketPath), appleTools()]);
  const initialized = config !== null;
  const keys = keysPresent(keysDir);
  const nshOk = nshPath !== null && nshError === null;
  const socketOk = health.ok;
  const runningIdentity = health.install;
  const identityMatch = socketOk
    ? Boolean(runningIdentity)
      && runningIdentity.packageRoot === identity.packageRoot
      && runningIdentity.packageHash === identity.packageHash
    : null;
  const startedBeforeCode = socketOk && typeof health.startedAt === 'string'
    ? Date.parse(health.startedAt) < identity.newestMtimeMs
    : false;
  const stale = socketOk === true && (identityMatch === false || startedBeforeCode);

  const checks = [
    check('bridge-cli', true, `jiezi-bridge ${VERSION} at ${fileURLToPath(new URL('./cli.js', import.meta.url))}`),
    check(
      'state',
      initialized,
      initialized ? `initialized at ${stateDir}` : `not initialized at ${stateDir}`,
    ),
    check('keys', keys, keys ? `development keys present in ${keysDir}` : `no development keys in ${keysDir}`),
    check(
      'nsh',
      nshOk,
      nshOk ? `nsh ${nshReportedVersion ?? ''} at ${nshPath}` : `nsh unavailable: ${nshError}`,
    ),
    check(
      'socket',
      socketOk,
      socketOk ? `bridge answered at ${socketPath}` : `bridge is not running at ${socketPath} (${health.error ?? 'no answer'})`,
    ),
    check(
      'bridge-identity',
      socketOk ? !stale : true,
      !socketOk
        ? 'not checked while the bridge is stopped'
        : stale
          ? `the running bridge (${health.version ?? 'unknown'}) predates or differs from this package (${identity.version} ${identity.packageHash}); restart it`
          : `running bridge matches this package (${identity.version} ${identity.packageHash})`,
    ),
    check(
      'apple-tools',
      apple.devicectl || apple.simctl,
      apple.devicectl || apple.simctl
        ? `xcrun found ${[apple.devicectl ? 'devicectl' : null, apple.simctl ? 'simctl' : null].filter(Boolean).join(' + ')}`
        : apple.note ?? 'Apple device tooling is unavailable',
    ),
  ];

  const notes = [];
  if (!initialized) notes.push('Initialize the bridge to create local development keys and the TLS certificate.');
  if (!nshOk) notes.push('Install the pinned Native Shell toolchain, pass an explicit nsh path, or run doctor --fix to rewrite a stale configured path.');
  if (health.ok && health.version !== VERSION) {
    notes.push(`The running bridge is ${health.version ?? 'unknown'}; this package bundles ${VERSION}. Restart it to use the packaged version.`);
  }
  if (stale) {
    notes.push('The running bridge predates or differs from this package; run the panel restart action or `jiezi-bridge doctor --fix` from the packaged CLI.');
  }
  if (socketOk && health.nsh !== null && nshPath !== null && resolve(health.nsh) !== resolve(nshPath)) {
    notes.push(`The running bridge resolved nsh at ${health.nsh}; this doctor resolves ${nshPath}. Restart the bridge to use the current toolchain.`);
  }
  if (!apple.devicectl && !apple.simctl) {
    notes.push('A simulator or paired iPhone with the JieZi App is required to preview and debug mini-apps.');
  }

  return {
    ok: true,
    version: VERSION,
    install: {
      path: identity.packageRoot,
      packageRoot: identity.packageRoot,
      packageHash: identity.packageHash,
      version: identity.version,
      newestMtimeMs: identity.newestMtimeMs,
    },
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cli: { path: fileURLToPath(new URL('./cli.js', import.meta.url)) },
    state: { dir: stateDir, initialized, configPath: join(stateDir, 'config.json'), keysPresent: keys },
    socket: {
      path: socketPath,
      running: socketOk,
      version: health.version,
      startedAt: health.startedAt,
      install: runningIdentity,
      identityMatch,
      stale,
      nsh: health.nsh,
      error: health.error,
    },
    nsh: {
      found: nshPath !== null,
      configured: configuredNsh ?? null,
      path: nshPath,
      version: nshReportedVersion,
      error: nshError,
      candidates: candidates.slice(0, MAX_CANDIDATES),
      candidateCount: candidates.length,
    },
    apple,
    checks,
    notes,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Apply only the safe repair doctor owns: when the configured nsh path is no
 * longer executable and discovery found another one, persist that path. It
 * never creates keys, initializes trust, pairs a device, or restarts a process.
 */
export async function doctorFix(args = {}) {
  const report = await doctorReport(args);
  const fixes = [];
  const config = readConfig(report.state.dir);
  if (config !== null && report.nsh.found && report.nsh.path !== null
    && typeof config.nshPath === 'string' && resolve(config.nshPath) !== resolve(report.nsh.path)) {
    writeJsonAtomic(join(report.state.dir, 'config.json'), { ...config, nshPath: report.nsh.path });
    fixes.push(`nshPath ${config.nshPath} -> ${report.nsh.path}`);
  }
  if (fixes.length === 0) {
    return { ...report, fixed: false, fixes, note: 'No safe repair was needed; restart the bridge if its identity is stale.' };
  }
  return { ...report, fixed: true, fixes, note: 'Updated the configured nsh path; restart the bridge so the running process uses it.' };
}

// Read-only environment report behind `jiezi-bridge doctor` and the DSH setup
// panel. It never creates trust material and never throws for a missing nsh or
// an uninitialized state directory; every failure becomes a check row.

import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNsh, nshCandidates, nshVersion, run } from './build.js';
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
      'apple-tools',
      apple.devicectl || apple.simctl,
      apple.devicectl || apple.simctl
        ? `xcrun found ${[apple.devicectl ? 'devicectl' : null, apple.simctl ? 'simctl' : null].filter(Boolean).join(' + ')}`
        : apple.note ?? 'Apple device tooling is unavailable',
    ),
  ];

  const notes = [];
  if (!initialized) notes.push('Initialize the bridge to create local development keys and the TLS certificate.');
  if (!nshOk) notes.push('Install the pinned Native Shell toolchain or pass an explicit nsh path.');
  if (health.ok && health.version !== VERSION) {
    notes.push(`The running bridge is ${health.version ?? 'unknown'}; this package bundles ${VERSION}. Restart it to use the packaged version.`);
  }
  if (!apple.devicectl && !apple.simctl) {
    notes.push('A simulator or paired iPhone with the JieZi App is required to preview and debug mini-apps.');
  }

  return {
    ok: true,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cli: { path: fileURLToPath(new URL('./cli.js', import.meta.url)) },
    state: { dir: stateDir, initialized, configPath: join(stateDir, 'config.json'), keysPresent: keys },
    socket: { path: socketPath, running: socketOk, version: health.version, error: health.error },
    nsh: {
      found: nshPath !== null,
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

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeSupervisor, supervisedBridgeEnvironment } from '../lib/host/bridge-supervisor.js';
import { BridgeClient, resolveBridgeSettings } from '../lib/host/bridge-client.js';
import { startFakeBridge } from './support/fake-bridge.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = join(ROOT, 'vendor/bridge/src/cli.js');
const NSH = process.env.NSH_TOOLCHAIN ?? join(process.env.HOME ?? '', 'Desktop/native-shell-demo/.tooling/nsh/bin/nsh');

test('bridge child environment excludes provider and pairing credentials', () => {
  const environment = supervisedBridgeEnvironment({
    PATH: '/usr/bin', HOME: '/Users/test', NSH_TOOLING: '/opt/nsh',
    DEEPSEEK_API_KEY: 'secret', JIEZI_DEVICE_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
  });
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOME, '/Users/test');
  assert.equal(environment.NSH_TOOLING, '/opt/nsh');
  assert.equal(environment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal('DEEPSEEK_API_KEY' in environment, false);
  assert.equal('JIEZI_DEVICE_TOKEN' in environment, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in environment, false);
});

test('Host supervisor starts only an initialized bridge and stops its owned test child', { timeout: 60_000 }, async (context) => {
  if (!existsSync(NSH)) {
    context.skip(`pinned nsh toolchain not found at ${NSH}`);
    return;
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-supervisor-'));
  execFileSync(process.execPath, [CLI, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0'], { encoding: 'utf8' });
  const settings = resolveBridgeSettings({
    socketPath: join(stateDir, 'bridge.sock'), stateDir, bridgeCliPath: CLI, autoStart: true, timeoutMs: 2_000,
  });
  const supervisor = new BridgeSupervisor(settings);
  try {
    await supervisor.ensureRunning();
    const client = new BridgeClient({ ...settings, autoStart: false });
    const health = await client.get('/v1/health');
    assert.equal(health.ok, true);
    assert.equal(health.projectRoot, join(stateDir, 'projects'));
    const expected = supervisor.identity();
    assert.notEqual(expected, null);
    assert.equal(health.install.packageRoot, expected.packageRoot);
    assert.equal(health.install.packageHash, expected.packageHash);
    assert.equal(health.install.version, expected.version);
    assert.equal(health.version, expected.version);
    await supervisor.ensureRunning();

    const before = health.startedAt;
    await supervisor.restart();
    const restarted = await client.get('/v1/health');
    assert.equal(restarted.ok, true);
    assert.notEqual(restarted.startedAt, before);
    assert.equal(restarted.install.packageHash, expected.packageHash);
  } finally {
    await supervisor.stopOwned();
  }
  await assert.rejects(new BridgeClient({ ...settings, autoStart: false }).get('/v1/health'));
  rmSync(stateDir, { recursive: true, force: true });
});

test('Host supervision never auto-initializes an unknown state directory', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-supervisor-empty-'));
  const settings = resolveBridgeSettings({
    socketPath: join(stateDir, 'bridge.sock'), stateDir, bridgeCliPath: CLI, autoStart: true, timeoutMs: 1_000,
  });
  try {
    await assert.rejects(new BridgeSupervisor(settings).ensureRunning(), (error) => error.code === 'bridge_not_configured');
    assert.equal(existsSync(join(stateDir, 'config.json')), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Host supervision refuses a running bridge from another bundle version', async () => {
  const bridge = await startFakeBridge({
    'GET /v1/health': () => ({ body: { ok: true, version: '0.0.0-other' } }),
  });
  try {
    const settings = resolveBridgeSettings({
      socketPath: bridge.socketPath,
      stateDir: dirname(bridge.socketPath),
      bridgeCliPath: CLI,
      autoStart: true,
      timeoutMs: 2_000,
    });
    await assert.rejects(
      new BridgeSupervisor(settings).ensureRunning(),
      (error) => error.code === 'bridge_identity_mismatch' && /not this package/.test(error.message),
    );
  } finally {
    await bridge.close();
  }
});

test('projectLayout defaults to the working directory and accepts the named layout', () => {
  assert.equal(resolveBridgeSettings({}).projectLayout, 'working-directory');
  assert.equal(resolveBridgeSettings({ projectLayout: 'named-subdirectory' }).projectLayout, 'named-subdirectory');
  assert.equal(resolveBridgeSettings({ projectLayout: 'bogus' }).projectLayout, 'working-directory');
});
test('supervisor restarts a same-version bridge whose copied code changed after start', { timeout: 90_000 }, async (context) => {
  if (!existsSync(NSH)) {
    context.skip(`pinned nsh toolchain not found at ${NSH}`);
    return;
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-supervisor-stale-'));
  const bridgeCopy = join(stateDir, 'bridge-copy');
  cpSync(join(ROOT, 'vendor', 'bridge'), bridgeCopy, { recursive: true });
  const cli = join(bridgeCopy, 'src', 'cli.js');
  const socketPath = join(stateDir, 'bridge.sock');
  const env = { ...process.env, NSH_TOOLCHAIN: NSH };
  let manual = null;
  let supervisor = null;
  try {
    execFileSync(process.execPath, [cli, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0'], { encoding: 'utf8', env });
    manual = spawn(process.execPath, [cli, 'serve', '--state-dir', stateDir, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const probe = new BridgeClient({ socketPath, stateDir, bridgeCliPath: cli, autoStart: false, timeoutMs: 1_000 });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const health = await probe.get('/v1/health');
        if (health.ok === true) break;
      } catch {
        // Wait for the manual bridge.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const before = await probe.get('/v1/health');
    assert.equal(before.ok, true);

    // Rewrite the same copied module after the old process started. The
    // version string is unchanged; only the content hash and mtime move.
    appendFileSync(join(bridgeCopy, 'src', 'version.js'), '\n// stale-copy marker\n');
    supervisor = new BridgeSupervisor(resolveBridgeSettings({
      socketPath, stateDir, bridgeCliPath: cli, autoStart: true, timeoutMs: 2_000,
    }));
    assert.notEqual(supervisor.identity().packageHash, before.install.packageHash);

    await supervisor.ensureRunning();
    const after = await probe.get('/v1/health');
    assert.equal(after.ok, true);
    assert.equal(after.install.packageHash, supervisor.identity().packageHash);
    assert.notEqual(after.pid, before.pid);
  } finally {
    await supervisor?.stopOwned();
    if (manual !== null && manual.exitCode === null && manual.signalCode === null) {
      manual.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        manual.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

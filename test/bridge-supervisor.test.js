import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
    await supervisor.ensureRunning();
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
      (error) => error.code === 'bridge_version_mismatch',
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

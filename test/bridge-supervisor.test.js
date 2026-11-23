import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
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

test('bridge package replacement cannot change the default pairing state directory', () => {
  const oldPackage = resolveBridgeSettings({ bridgeCliPath: '/tmp/old-dsh-jiezi/lib/bridge/cli.js' });
  const newPackage = resolveBridgeSettings({ bridgeCliPath: '/tmp/new-dsh-jiezi/lib/bridge/cli.js' });
  assert.equal(newPackage.socketPath, oldPackage.socketPath);
  assert.equal(newPackage.stateDir, oldPackage.stateDir);
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
    const pairCode = JSON.parse(execFileSync(process.execPath, [
      cli, 'pair-code', '--state-dir', stateDir,
    ], { encoding: 'utf8', env })).code;
    const paired = await pairDevice(before.deviceUrl, pairCode);
    const beforeDevices = await probe.get('/v1/devices');
    assert.equal(beforeDevices.devices.length, 1);
    assert.equal(beforeDevices.devices[0].deviceId, paired.deviceId);

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

    // Package replacement restarts the process, not the trust relationship.
    // The original phone credential must authenticate without another QR.
    const upgrade = await bearerUpgrade(after.deviceUrl, paired.deviceToken);
    assert.equal(upgrade.status, 101);
    let afterDevices;
    const onlineDeadline = Date.now() + 2_000;
    do {
      afterDevices = await probe.get('/v1/devices');
      if (afterDevices.devices[0]?.online === true) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } while (Date.now() < onlineDeadline);
    // A 101 alone is not authentication: an unknown token is closed with 4001
    // after upgrade. Presence proves the original bearer was actually accepted.
    assert.equal(afterDevices.devices[0].online, true);
    upgrade.socket.destroy();
    assert.equal(afterDevices.devices.length, 1);
    assert.equal(afterDevices.devices[0].deviceId, paired.deviceId);
    assert.equal(afterDevices.devices[0].pairedAt, beforeDevices.devices[0].pairedAt);
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

function pairDevice(deviceUrl, code) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(deviceUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('pairing timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        v: 1,
        id: 'supervisor-pair-test',
        type: 'pair',
        ts: new Date().toISOString(),
        payload: {
          code,
          deviceName: 'Upgrade Test iPhone',
          targetKind: 'physical',
          publicKey: Buffer.from('supervisor-upgrade-key').toString('base64'),
        },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'paired') {
        clearTimeout(timer);
        socket.close();
        resolvePromise(message.payload);
      } else if (message.type === 'pairError') {
        clearTimeout(timer);
        socket.close();
        reject(new Error(message.payload.message));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('pairing websocket failed'));
    });
  });
}

function bearerUpgrade(deviceUrl, token) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(deviceUrl);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        Authorization: `Bearer ${token}`,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('bearer reconnect timed out'));
    }, 10_000);
    req.on('upgrade', (response, socket) => {
      clearTimeout(timer);
      resolvePromise({ status: response.statusCode, socket });
    });
    req.on('response', (response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`bearer reconnect refused with ${response.statusCode}`));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

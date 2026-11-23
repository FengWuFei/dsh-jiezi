import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JieZiOperations } from '../lib/host/operations.js';
import { bundledBridgeVersion, resolveBridgeSettings } from '../lib/host/bridge-client.js';
import { startFakeBridge } from './support/fake-bridge.js';

const BRIDGE_VERSION = bundledBridgeVersion() ?? '0.2.0';

function target() {
  return {
    hostDeviceId: '00008120-TEST', kind: 'physical', name: 'LY', model: 'iPhone',
    runtime: '27.2', state: 'booted', connected: false, paired: true, developerMode: true,
  };
}

function fakeHost(device, launches) {
  return {
    async listTargets() { return [target()]; },
    listBindings() {
      return launches.bound ? [{ deviceId: 'dev_1', hostDeviceId: '00008120-TEST', kind: 'physical', name: 'LY', boundAt: 'now' }] : [];
    },
    async resolveBinding(request) {
      launches.bindingRequests.push(request);
      launches.bound = true;
      return {
        binding: { deviceId: 'dev_1', hostDeviceId: '00008120-TEST', kind: 'physical', name: 'LY', boundAt: 'now' },
        target: target(),
      };
    },
    async launch(received) {
      launches.targets.push(received);
      Object.assign(device, {
        online: true, developerMode: true, automation: true,
        activeApp: { appId: null, releaseId: null, instanceId: null, installedApps: [] },
      });
    },
    removeBinding() { launches.bound = false; },
  };
}

test('production deploy automatically launches and verifies an offline paired device', { timeout: 15_000 }, async () => {
  const device = {
    deviceId: 'dev_1', name: 'LY', targetKind: 'physical', online: false,
    developerMode: false, automation: false, activeApp: null,
  };
  const bridge = await startFakeBridge({
    'GET /v1/health': () => ({ body: { ok: true, version: BRIDGE_VERSION } }),
    'GET /v1/devices': () => ({ body: { ok: true, devices: [device] } }),
    'POST /v1/deploy': (body) => ({ body: { ok: true, opId: 'op_1', state: 'pending', ...body } }),
  });
  const launches = { targets: [], bindingRequests: [], bound: false };
  try {
    const operations = new JieZiOperations(resolveBridgeSettings({
      socketPath: bridge.socketPath, stateDir: '/tmp/unused-jiezi-state', autoStart: true, timeoutMs: 2_000,
    }), fakeHost(device, launches));
    const result = await operations.deploy({ deviceId: 'dev_1', releaseId: 'rel_1' });
    assert.equal(result.opId, 'op_1');
    assert.equal(launches.targets.length, 1);
    assert.equal(launches.targets[0].hostDeviceId, '00008120-TEST');
    assert.equal(launches.bindingRequests[0].targetKind, 'physical');
    assert.equal(device.automation, true);
    assert.ok(bridge.requests.some((request) => request.method === 'POST' && request.path === '/v1/deploy'));
  } finally {
    await bridge.close();
  }
});

test('ready fast path does not relaunch and explicit automation revocation is respected', { timeout: 15_000 }, async () => {
  const device = {
    deviceId: 'dev_1', name: 'LY', targetKind: 'physical', online: true,
    developerMode: true, automation: true,
    activeApp: { appId: null, releaseId: null, instanceId: null, installedApps: [] },
  };
  const bridge = await startFakeBridge({
    'GET /v1/health': () => ({ body: { ok: true, version: BRIDGE_VERSION } }),
    'GET /v1/devices': () => ({ body: { ok: true, devices: [device] } }),
  });
  const launches = { targets: [], bindingRequests: [], bound: true };
  try {
    const operations = new JieZiOperations(resolveBridgeSettings({
      socketPath: bridge.socketPath, stateDir: '/tmp/unused-jiezi-state', autoStart: true, timeoutMs: 2_000,
    }), fakeHost(device, launches));
    const ready = await operations.device({ action: 'ensure_ready', deviceId: 'dev_1' });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.launched, false);
    assert.equal(launches.targets.length, 0);

    device.automation = false;
    await assert.rejects(
      operations.device({ action: 'ensure_ready', deviceId: 'dev_1' }),
      (error) => error.code === 'automation_disabled',
    );
    assert.equal(launches.targets.length, 0);

    Object.assign(device, {
      online: false, activeApp: null,
      revocation: { developerMode: true, automation: true, updatedAt: 'now' },
    });
    await assert.rejects(
      operations.device({ action: 'ensure_ready', deviceId: 'dev_1', waitMs: 1_000 }),
      (error) => error.code === 'automation_disabled',
    );
    assert.equal(launches.targets.length, 0);
  } finally {
    await bridge.close();
  }
});

test('miniapp_screen resolves one binding and returns a PNG path', { timeout: 15_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-screen-op-'));
  const device = {
    deviceId: 'dev_1', name: 'LY', targetKind: 'physical', online: true,
    developerMode: true, automation: true, activeApp: null,
  };
  const bridge = await startFakeBridge({
    'GET /v1/devices': () => ({ body: { ok: true, devices: [device] } }),
  });
  const captured = [];
  const host = {
    async listTargets() { return [target()]; },
    listBindings() { return []; },
    async resolveBinding() {
      return {
        binding: { deviceId: 'dev_1', hostDeviceId: '00008120-TEST', kind: 'physical', name: 'LY', boundAt: 'now' },
        target: target(),
      };
    },
    async launch() {},
    async captureScreen(received, destination) {
      captured.push({ target: received, destination });
      writeFileSync(destination, 'png');
    },
    removeBinding() {},
  };
  try {
    const operations = new JieZiOperations(resolveBridgeSettings({
      socketPath: bridge.socketPath, stateDir, autoStart: false, timeoutMs: 2_000,
    }), host);
    const result = await operations.screen({ deviceId: 'dev_1' });
    assert.equal(result.ok, true);
    assert.equal(result.hostDeviceId, '00008120-TEST');
    assert.equal(result.kind, 'physical');
    assert.match(result.path, /screenshots\/screen_[a-f0-9]{16}\.png$/);
    assert.equal(existsSync(result.path), true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].target.hostDeviceId, '00008120-TEST');
  } finally {
    await bridge.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('miniapp_open returns the running instance after a restart', { timeout: 15_000 }, async () => {
  const device = {
    deviceId: 'dev_1', name: 'LY', targetKind: 'physical', online: true,
    developerMode: true, automation: true, activeApp: null,
  };
  const bridge = await startFakeBridge({
    'GET /v1/devices': () => ({ body: { ok: true, devices: [device] } }),
    'POST /v1/open': (body) => ({
      body: {
        ok: true,
        request: {
          requestId: 'open_1', deviceId: 'dev_1', appId: body.appId, state: 'pending',
          instanceId: null, error: null,
        },
      },
    }),
    'GET /v1/open/open_1': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'open_1', deviceId: 'dev_1', appId: 'com.jiezi.test.demo', state: 'done',
          instanceId: 'instance-open', error: null,
        },
      },
    }),
  });
  try {
    const operations = new JieZiOperations(resolveBridgeSettings({
      socketPath: bridge.socketPath, stateDir: '/tmp/unused-jiezi-state', autoStart: false, timeoutMs: 2_000,
    }));
    const result = await operations.open({ deviceId: 'dev_1', appId: 'com.jiezi.test.demo' });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'done');
    assert.equal(result.appId, 'com.jiezi.test.demo');
    assert.equal(result.instanceId, 'instance-open');
    const sent = bridge.requests.find((request) => request.method === 'POST' && request.path === '/v1/open');
    assert.equal(sent.body.deviceId, 'dev_1');
    assert.equal(sent.body.appId, 'com.jiezi.test.demo');
  } finally {
    await bridge.close();
  }
});

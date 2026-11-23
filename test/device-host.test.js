import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AppleDeviceHost,
  JIEZI_HOST_BUNDLE_ID,
  parseDevicectlDevices,
} from '../lib/host/apple-device-host.js';

function physical(properties = true) {
  if (properties) {
    return {
      identifier: 'core-device-id',
      properties: {
        hardware: { platform: 'iOS', reality: 'physical', udid: '00008120-TEST', marketingName: 'iPhone 15 Plus' },
        software: { osVersionNumber: { stringValue: '27.2.1' } },
        state: { name: 'LY', bootState: 'booted', developerModeStatus: { enabled: { mode: 1 } } },
        connection: { pairingState: 'paired', state: 'disconnected', transportType: 'localNetwork' },
      },
    };
  }
  return {
    hardwareProperties: { platform: 'iOS', reality: 'physical', udid: '00008120-LEGACY', marketingName: 'iPhone 15 Plus' },
    deviceProperties: { name: 'Legacy Phone', bootState: 'booted', osVersionNumber: '26.2', developerModeStatus: 'enabled' },
    connectionProperties: { pairingState: 'paired', tunnelState: 'connected' },
  };
}

function simulator(udid, name, state = 'Booted') {
  return {
    properties: {
      hardware: { platform: 'iOS', reality: 'simulated', udid, marketingName: name },
      software: { osVersionNumber: { stringValue: '26.2' } },
      state: { name, bootState: state },
      connection: { pairingState: 'paired', state: state === 'Booted' ? 'connected' : 'disconnected' },
    },
  };
}

function inventory(devices) {
  return JSON.stringify({ info: { outcome: 'success' }, result: { devices } });
}

test('devicectl parser handles current properties and legacy compatibility fields', () => {
  const targets = parseDevicectlDevices(JSON.parse(inventory([physical(true), physical(false)])));
  assert.equal(targets.length, 2);
  const current = targets.find((target) => target.hostDeviceId === '00008120-TEST');
  assert.deepEqual(current, {
    hostDeviceId: '00008120-TEST', kind: 'physical', name: 'LY', model: 'iPhone 15 Plus',
    runtime: '27.2.1', state: 'booted', connected: false, paired: true, developerMode: true,
  });
  const legacy = targets.find((target) => target.hostDeviceId === '00008120-LEGACY');
  assert.equal(legacy.name, 'Legacy Phone');
  assert.equal(legacy.runtime, '26.2');
  assert.equal(legacy.connected, true);
  assert.equal(legacy.developerMode, true);
});

test('binding persists and physical launch uses fixed non-destructive argv', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-binding-'));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: args.includes('list') ? inventory([physical(true)]) : '{"info":{"outcome":"success"}}', stderr: '' };
  };
  try {
    const host = new AppleDeviceHost(stateDir, runner);
    const resolved = await host.resolveBinding({ deviceId: 'dev_1', deviceName: 'LY', targetKind: 'physical' });
    assert.equal(resolved.binding.hostDeviceId, '00008120-TEST');
    assert.equal(resolved.target.kind, 'physical');
    assert.equal(host.listBindings().length, 1);
    assert.equal(statSync(join(stateDir, 'host-device-bindings.json')).mode & 0o777, 0o600);

    await host.launch(resolved.target);
    const launch = calls.find((args) => args.includes('process') && args.includes('launch'));
    assert.ok(launch);
    assert.deepEqual(launch, [
      'devicectl', 'device', 'process', 'launch', '--device', '00008120-TEST',
      '--activate', '--timeout', '25', '--json-output', '-', JIEZI_HOST_BUNDLE_ID,
    ]);
    assert.equal(launch.includes('--terminate-existing'), false);

    const restored = new AppleDeviceHost(stateDir, runner);
    const existing = await restored.resolveBinding({ deviceId: 'dev_1', deviceName: 'LY', targetKind: 'physical' });
    assert.equal(existing.binding.hostDeviceId, '00008120-TEST');
    await assert.rejects(
      restored.resolveBinding({ deviceId: 'dev_1', deviceName: 'LY', targetKind: 'physical', hostDeviceId: 'OTHER' }),
      (error) => error.code === 'host_binding_required',
    );
    const stored = JSON.parse(readFileSync(join(stateDir, 'host-device-bindings.json'), 'utf8'));
    assert.equal(stored.schemaVersion, 1);
    assert.equal(JSON.stringify(stored).includes('token'), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ambiguous automatic binding fails closed without writing a binding', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-ambiguous-'));
  const runner = async () => ({ code: 0, stdout: inventory([simulator('SIM-A', 'iPhone A'), simulator('SIM-B', 'iPhone B')]), stderr: '' });
  try {
    const host = new AppleDeviceHost(stateDir, runner);
    await assert.rejects(
      host.resolveBinding({ deviceId: 'dev_sim', deviceName: 'Unmatched', targetKind: 'simulator' }),
      (error) => error.code === 'host_binding_required' && /SIM-A/.test(error.message) && /SIM-B/.test(error.message),
    );
    assert.deepEqual(host.listBindings(), []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('legacy option fallback and failed launch JSON outcomes stay honest', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-outcome-'));
  let listCalls = 0;
  const runner = async (args) => {
    if (args.includes('list')) {
      listCalls += 1;
      if (args.includes('--omit-deprecated-fields-in-json')) {
        return { code: 64, stdout: '{"info":{"outcome":"failed"},"error":"unexpected argument"}', stderr: 'unexpected argument' };
      }
      return { code: 0, stdout: inventory([physical(false)]), stderr: '' };
    }
    return { code: 0, stdout: '{"info":{"outcome":"failed"},"error":{"message":"launch rejected"}}', stderr: '' };
  };
  try {
    const host = new AppleDeviceHost(stateDir, runner);
    const targets = await host.listTargets();
    assert.equal(targets[0].hostDeviceId, '00008120-LEGACY');
    assert.equal(listCalls, 2);
    await assert.rejects(host.launch(targets[0]), (error) => error.code === 'host_launch_failed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('structurally corrupt bindings fail closed instead of being overwritten', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-corrupt-'));
  const path = join(stateDir, 'host-device-bindings.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, bindings: [{ deviceId: 'dev_incomplete' }] }));
  try {
    const host = new AppleDeviceHost(stateDir, async () => ({ code: 0, stdout: inventory([]), stderr: '' }));
    assert.throws(() => host.listBindings(), (error) => error.code === 'bridge_protocol');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { schemaVersion: 1, bindings: [{ deviceId: 'dev_incomplete' }] });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('simulator recovery boots only when needed and never terminates the App', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-sim-'));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const host = new AppleDeviceHost(stateDir, runner);
    await host.launch({ ...parseDevicectlDevices(JSON.parse(inventory([simulator('SIM-OFF', 'Off', 'Shutdown')])))[0] });
    assert.deepEqual(calls, [
      ['simctl', 'boot', 'SIM-OFF'],
      ['simctl', 'bootstatus', 'SIM-OFF', '-b'],
      ['simctl', 'launch', 'SIM-OFF', JIEZI_HOST_BUNDLE_ID],
    ]);
    assert.equal(calls.flat().includes('--terminate-running-process'), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('screen capture uses fixed host argv and a 0600 PNG', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-device-screen-'));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args.includes('screenshot') || args.includes('capture')) {
      writeFileSync(args[args.length - 1], 'png');
    }
    return {
      code: 0,
      stdout: args.includes('list') ? inventory([physical(true), simulator('SIM-A', 'iPhone A')]) : '{"info":{"outcome":"success"}}',
      stderr: '',
    };
  };
  try {
    const host = new AppleDeviceHost(stateDir, runner);
    const phone = await host.resolveBinding({ deviceId: 'dev_phone', deviceName: 'LY', targetKind: 'physical' });
    const phonePath = join(stateDir, 'screenshots', 'phone.png');
    await host.captureScreen(phone.target, phonePath);
    const phoneCall = calls.find((args) => args.includes('capture') && args.includes('screenshot'));
    assert.deepEqual(phoneCall, [
      'devicectl', 'device', 'capture', 'screenshot',
      '--device', '00008120-TEST', '--destination', phonePath,
    ]);
    assert.equal(statSync(phonePath).mode & 0o777, 0o600);

    const simulatorTarget = await host.resolveBinding({ deviceId: 'dev_sim', deviceName: 'iPhone A', targetKind: 'simulator' });
    const simPath = join(stateDir, 'screenshots', 'sim.png');
    await host.captureScreen(simulatorTarget.target, simPath);
    const simCall = calls.find((args) => args[0] === 'simctl' && args.includes('screenshot'));
    assert.deepEqual(simCall, ['simctl', 'io', 'SIM-A', 'screenshot', simPath]);
    assert.equal(statSync(simPath).mode & 0o777, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { JieZiOperations } from '../lib/host/operations.js';
import { resolveBridgeSettings } from '../lib/host/bridge-client.js';
import { durablePairingView, selectPairingView } from '../lib/shared/protocol.js';
import { startFakeBridge } from './support/fake-bridge.js';

const EXPIRES = '2026-11-23T12:00:00.000Z';

function pairedDevice(deviceId = 'dev_existing') {
  return {
    deviceId,
    deviceName: 'Paired iPhone',
    targetKind: 'physical',
    online: true,
    developerMode: true,
    automation: true,
    pairedAt: '2026-11-22T12:00:00.000Z',
    lastSeenAt: '2026-11-23T12:00:00.000Z',
  };
}

function handlers(devices, pairingSession = null) {
  return {
    'GET /v1/health': () => ({
      body: {
        ok: true,
        version: '0.3.4',
        deviceUrl: 'wss://192.168.1.5:7331/device',
        projectRoot: '/tmp/jiezi/projects',
        capabilities: ['deploy', 'automation'],
      },
    }),
    'GET /v1/devices': () => ({ body: { ok: true, devices: devices() } }),
    'GET /v1/ops': () => ({ body: { ok: true, ops: [] } }),
    'POST /v1/pairing-sessions': () => ({
      body: {
        ok: true,
        pairing: {
          sessionId: 'pair_existing',
          code: 'ABCDEFGH',
          endpoint: 'wss://192.168.1.5:7331/device',
          certificateFingerprint: 'f'.repeat(64),
          expiresAt: EXPIRES,
          bridgeName: 'paired-mac',
        },
      },
    }),
    'GET /v1/pairing-sessions/pair_existing': () => pairingSession(),
  };
}

function operationsFor(socketPath, deviceHost) {
  return new JieZiOperations(resolveBridgeSettings({
    socketPath,
    stateDir: dirname(socketPath),
    autoStart: false,
    timeoutMs: 2_000,
  }), deviceHost);
}

function localQr(state) {
  return {
    payload: {
      schema: 'jiezi.pairing.v1',
      sessionId: 'pair_local',
      endpoint: 'wss://192.168.1.5:7331/device',
      code: 'ABCDEFGH',
      certificateFingerprint: 'f'.repeat(64),
      expiresAt: EXPIRES,
    },
    state,
    deviceId: state === 'paired' ? 'dev_existing' : null,
    bridgeName: 'paired-mac',
    expiresAt: EXPIRES,
  };
}

test('client state selection supersedes an expired local QR with durable pairing', () => {
  const host = durablePairingView([{ deviceId: 'dev_existing' }], 'paired-mac');
  const selected = selectPairingView(localQr('expired'), host);
  assert.strictEqual(selected, host);
  assert.equal(selected.state, 'paired');
  assert.equal(selected.payload, null, 'the expired-auto-generation effect has no expired state to consume');
});

test('client state selection preserves a waiting add-device QR but clears it on none', () => {
  const waiting = localQr('waiting');
  const durable = durablePairingView([{ deviceId: 'dev_existing' }]);
  assert.strictEqual(selectPairingView(waiting, durable), waiting);
  const empty = durablePairingView([]);
  assert.strictEqual(selectPairingView(waiting, empty), empty);
  assert.strictEqual(selectPairingView(localQr('paired'), empty), empty);
});

test('a fresh plugin instance restores durable pairing without creating a QR', async () => {
  const bridge = await startFakeBridge(handlers(() => [pairedDevice()], () => {
    throw new Error('no QR session should be read');
  }));
  try {
    const operations = operationsFor(bridge.socketPath);
    const status = await operations.status();
    assert.equal(status.devices.length, 1);
    assert.equal(status.pairing.state, 'paired');
    assert.equal(status.pairing.deviceId, 'dev_existing');
    assert.equal(status.pairing.payload, null);

    const direct = await operations.pairingStatus();
    assert.equal(direct.pairing.state, 'paired');
    assert.equal(direct.pairing.deviceId, 'dev_existing');
    assert.equal(bridge.requests.filter((entry) => entry.method === 'POST' && entry.path === '/v1/pairing-sessions').length, 0);
  } finally {
    await bridge.close();
  }
});

test('a forgotten QR session after bridge restart cannot hide durable pairing', async () => {
  const bridge = await startFakeBridge(handlers(() => [pairedDevice()], () => ({
    status: 404,
    body: { ok: false, error: { code: 'unknown_pairing_session', message: 'unknown pairing session' } },
  })));
  try {
    const operations = operationsFor(bridge.socketPath);
    await operations.createPairing();
    const before = bridge.requests.length;
    const status = await operations.status();
    assert.equal(status.pairing.state, 'paired');
    assert.equal(status.pairing.deviceId, 'dev_existing');
    assert.equal(status.pairing.payload, null);
    assert.equal(bridge.requests.slice(before).filter((entry) => entry.method === 'POST' && entry.path === '/v1/pairing-sessions').length, 0);
  } finally {
    await bridge.close();
  }
});

test('an explicitly waiting QR remains visible beside an existing paired device', async () => {
  const bridge = await startFakeBridge(handlers(() => [pairedDevice()], () => ({
    body: {
      ok: true,
      pairing: { sessionId: 'pair_existing', state: 'waiting', expiresAt: EXPIRES, deviceId: null },
    },
  })));
  try {
    const operations = operationsFor(bridge.socketPath);
    await operations.createPairing();
    const status = await operations.status();
    assert.equal(status.devices.length, 1);
    assert.equal(status.pairing.state, 'waiting');
    assert.equal(status.pairing.payload.sessionId, 'pair_existing');
  } finally {
    await bridge.close();
  }
});

test('multiple durable devices restore paired state without selecting one arbitrarily', async () => {
  const bridge = await startFakeBridge(handlers(
    () => [pairedDevice('dev_one'), pairedDevice('dev_two')],
    () => { throw new Error('no QR session should be read'); },
  ));
  try {
    const status = await operationsFor(bridge.socketPath).status();
    assert.equal(status.pairing.state, 'paired');
    assert.equal(status.pairing.deviceId, null);
    assert.equal(status.pairing.payload, null);
  } finally {
    await bridge.close();
  }
});

test('unpair clears remembered QR state when the last durable device is removed', async () => {
  let devices = [pairedDevice()];
  const routes = handlers(() => devices, () => ({
    body: {
      ok: true,
      pairing: { sessionId: 'pair_existing', state: 'paired', expiresAt: EXPIRES, deviceId: 'dev_existing' },
    },
  }));
  routes['POST /v1/unpair'] = () => {
    devices = [];
    return { body: { ok: true, deviceId: 'dev_existing' } };
  };
  const bridge = await startFakeBridge(routes);
  try {
    const operations = operationsFor(bridge.socketPath, { removeBinding() {} });
    await operations.createPairing();
    await operations.unpair({ deviceId: 'dev_existing' });
    const status = await operations.status();
    assert.equal(status.devices.length, 0);
    assert.equal(status.pairing.state, 'none');
    assert.equal(status.pairing.deviceId, null);
  } finally {
    await bridge.close();
  }
});

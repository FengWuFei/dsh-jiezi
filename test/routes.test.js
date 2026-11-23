import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, buildRoutes } from '../lib/host/index.js';
import { API_ROUTES } from '../lib/shared/protocol.js';
import { getSharedOperations } from '../lib/host/operations.js';
import { startFakeBridge } from './support/fake-bridge.js';

const EXPIRES = '2026-11-21T12:00:00.000Z';
const FINGERPRINT = 'f'.repeat(64);

function handlers() {
  return {
    'GET /v1/health': () => ({
      body: {
        ok: true, version: '0.2.0', deviceUrl: 'wss://192.168.1.5:7331/device',
        projectRoot: '/tmp/jiezi/projects', capabilities: ['deploy', 'automation'],
      },
    }),
    'GET /v1/devices': () => ({
      body: {
        ok: true,
        devices: [{
          deviceId: 'dev_1', name: 'iPhone 15', online: true, developerMode: true, automation: true,
          pairedAt: EXPIRES, lastSeenAt: EXPIRES,
          activeApp: {
            appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
            installedApps: [{ appId: 'com.jiezi.demo', title: 'Demo', releaseId: 'rel_1', state: 'running', active: true }],
          },
        }],
      },
    }),
    'GET /v1/ops': () => ({
      body: { ok: true, ops: [{ opId: 'op_1', deviceId: 'dev_1', releaseId: 'rel_1', state: 'running', failureLayer: null, evidenceId: null }] },
    }),
    'GET /v1/ops/op_1': () => ({
      body: { ok: true, op: { opId: 'op_1', deviceId: 'dev_1', releaseId: 'rel_1', state: 'running', evidenceId: 'ev_1' } },
    }),
    'GET /v1/evidence/ev_1': () => ({
      body: { ok: true, evidenceId: 'ev_1', releaseId: 'rel_1', opId: 'op_1', failureLayer: 'runtime', summary: 'threw', counts: { events: 3 }, truncated: false, path: '/tmp/ev_1.json' },
    }),
    'POST /v1/pairing-sessions': () => ({
      body: {
        ok: true,
        pairing: {
          sessionId: 'pair_abc', code: 'ABCDEFGH', endpoint: 'wss://192.168.1.5:7331/device',
          certificateFingerprint: FINGERPRINT, expiresAt: EXPIRES, bridgeName: 'macbook',
        },
      },
    }),
    'GET /v1/pairing-sessions/pair_abc': () => ({
      body: { ok: true, pairing: { sessionId: 'pair_abc', state: 'paired', expiresAt: EXPIRES, deviceId: 'dev_1' } },
    }),
    'POST /v1/deploy': (body) => (body.releaseId === 'rel_missing'
      ? { status: 409, body: { ok: false, error: { code: 'device_offline', message: 'device is not connected' } } }
      : { body: { ok: true, opId: 'op_1', state: 'pending' } }),
    'POST /v1/automation': () => ({
      body: {
        ok: true, deduplicated: false,
        request: {
          requestId: 'auto_1', opId: 'op_auto_1', deviceId: 'dev_1', action: 'tap',
          state: 'pending', appId: 'com.jiezi.demo', instanceId: 'inst_1', snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_1': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_1', opId: 'op_auto_1', deviceId: 'dev_1', action: 'tap', state: 'done',
          appId: 'com.jiezi.demo', instanceId: 'inst_1', error: null,
          snapshot: {
            snapshotId: 'snap_1', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
            mode: 'semantic', capabilities: ['tap'], truncated: false,
            nodes: [
              { alias: '0', testID: 'save', label: '保存', role: 'button', value: null, frame: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, visible: true, path: '0/0' },
              { alias: '1', testID: 'title', label: '芥子', role: 'text', value: null, frame: null, enabled: true, visible: true, path: '0/1' },
            ],
          },
        },
      },
    }),
    'GET /v1/events': () => ({ body: {} }),
  };
}

async function contextFor(socketPath) {
  const operations = getSharedOperations({ socketPath, timeoutMs: 2_000 });
  const routes = buildRoutes(operations);
  const ctx = {
    connection: {
      fetch: {
        register() { return async () => {}; },
      },
    },
  };
  return { operations, routes, ctx };
}

function call(routes, method, path, body) {
  const pathname = path.split('?')[0];
  const route = routes.find((entry) => entry.path === pathname && entry.methods.includes(method));
  assert.ok(route, `route ${method} ${pathname} is registered`);
  const init = method === 'POST'
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
    : { method };
  return route.fetch(new Request(`http://localhost${path}`, init));
}

test('host routes pair, summarize, deploy, diagnose, and automate', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge(handlers());
  try {
    const { operations, routes, ctx } = await contextFor(bridge.socketPath);
    // Connection keys its exact Fetch registry by path and rejects a repeat,
    // so every path must appear once with the union of its methods.
    assert.equal(routes.length, 9);
    assert.equal(new Set(routes.map((route) => route.path)).size, routes.length);
    assert.deepEqual(
      routes.find((route) => route.path === '/api/jiezi/pairing').methods,
      ['GET', 'POST'],
    );
    assert.deepEqual(
      routes.find((route) => route.path === '/api/jiezi/setup').methods,
      ['GET', 'POST'],
    );
    assert.deepEqual(
      routes.find((route) => route.path === '/api/jiezi/automation').methods,
      ['GET', 'POST'],
    );
    assert.equal(typeof ctx.connection.fetch.register, 'function');

    const created = await call(routes, 'POST', '/api/jiezi/pairing', { ttlMs: 120_000 });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.deepEqual(Object.keys(createdBody.pairing.payload).sort(), [
      'certificateFingerprint', 'code', 'endpoint', 'expiresAt', 'schema', 'sessionId',
    ]);
    assert.equal(createdBody.pairing.payload.schema, 'jiezi.pairing.v1');
    assert.equal(createdBody.pairing.payload.endpoint, 'wss://192.168.1.5:7331/device');
    assert.equal(createdBody.pairing.bridgeName, 'macbook');
    assert.equal(createdBody.pairing.payload.certificateFingerprint, FINGERPRINT);

    const paired = await call(routes, 'GET', '/api/jiezi/pairing?sessionId=pair_abc');
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json();
    assert.equal(pairedBody.pairing.state, 'paired');
    assert.equal(pairedBody.pairing.deviceId, 'dev_1');
    assert.equal(pairedBody.pairing.payload.sessionId, 'pair_abc');

    const status = await call(routes, 'GET', '/api/jiezi/status');
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.bridge.available, true);
    assert.equal(statusBody.bridge.version, '0.2.0');
    assert.equal(statusBody.setup.initialized, false);
    assert.equal(statusBody.setup.bridgeCliAvailable, true);
    assert.equal(statusBody.devices.length, 1);
    assert.equal(statusBody.devices[0].online, true);
    assert.equal(statusBody.devices[0].automation, true);
    assert.equal(statusBody.devices[0].activeApp.appId, 'com.jiezi.demo');
    assert.equal(statusBody.deployments[0].opId, 'op_1');
    assert.equal(statusBody.pairing.state, 'paired');

    const setup = await call(routes, 'GET', '/api/jiezi/setup');
    assert.equal(setup.status, 200);
    const setupBody = await setup.json();
    assert.equal(setupBody.ok, true);
    assert.equal(setupBody.state.initialized, false);
    assert.ok(Array.isArray(setupBody.checks));
    assert.ok(setupBody.checks.some((entry) => entry.id === 'bridge-cli' && entry.ok === true));

    const deployed = await call(routes, 'POST', '/api/jiezi/deploy', { deviceId: 'dev_1', releaseId: 'rel_1' });
    assert.equal(deployed.status, 200);
    assert.equal((await deployed.json()).opId, 'op_1');

    const operation = await call(routes, 'GET', '/api/jiezi/operation?opId=op_1');
    assert.equal(operation.status, 200);
    assert.equal((await operation.json()).op.state, 'running');

    const diagnostics = await call(routes, 'GET', '/api/jiezi/diagnostics?opId=op_1');
    assert.equal(diagnostics.status, 200);
    const diagnosticsBody = await diagnostics.json();
    assert.equal(diagnosticsBody.evidenceId, 'ev_1');
    assert.equal(diagnosticsBody.failureLayer, 'runtime');
    assert.equal(diagnosticsBody.path, '/tmp/ev_1.json');

    const started = await call(routes, 'POST', '/api/jiezi/automation', {
      action: 'tap', deviceId: 'dev_1', opId: 'op_auto_1',
      target: { testID: 'save' }, expect: { visibleLabel: '保存' }, timeoutMs: 2_000,
    });
    assert.equal(started.status, 200);
    const automationBody = await started.json();
    assert.equal(automationBody.state, 'done');
    assert.equal(automationBody.ok, true);
    assert.equal(automationBody.nodeCount, 2);
    assert.match(automationBody.outline, /testID="save"/);
    assert.equal(automationBody.outline.includes('"nodes"'), false);
    assert.equal(operations.recentAutomation()[0].requestId, 'auto_1');

    const read = await call(routes, 'GET', '/api/jiezi/automation?requestId=auto_1');
    assert.equal(read.status, 200);
    assert.equal((await read.json()).automation.state, 'done');
  } finally {
    await bridge.close();
  }
});

test('host routes return actionable JSON failures and bounded bodies', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge(handlers());
  try {
    const { routes } = await contextFor(bridge.socketPath);

    const offline = await call(routes, 'POST', '/api/jiezi/deploy', { deviceId: 'dev_1', releaseId: 'rel_missing' });
    assert.equal(offline.status, 409);
    const offlineBody = await offline.json();
    assert.equal(offlineBody.ok, false);
    assert.equal(offlineBody.error.code, 'device_offline');
    assert.equal(offlineBody.error.retryable, true);

    const noConsent = await call(routes, 'POST', '/api/jiezi/setup', {});
    assert.equal(noConsent.status, 400);
    assert.equal((await noConsent.json()).error.code, 'consent_required');

    const invalid = await call(routes, 'POST', '/api/jiezi/deploy', { deviceId: 'dev_1' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_request');

    const unpair = await call(routes, 'POST', '/api/jiezi/unpair', { deviceId: 'dev_1' });
    assert.equal(unpair.status, 501);
    const unpairBody = await unpair.json();
    assert.equal(unpairBody.error.code, 'unsupported');
    assert.match(unpairBody.error.message, /解除配对/);

    const route = routes.find((entry) => entry.path === '/api/jiezi/deploy' && entry.methods.includes('POST'));
    const oversize = await route.fetch(new Request('http://localhost/api/jiezi/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '20000' },
      body: JSON.stringify({ deviceId: 'dev_1', releaseId: 'x'.repeat(20_000) }),
    }));
    assert.equal(oversize.status, 413);
    assert.equal((await oversize.json()).error.code, 'body_too_large');

    const malformed = await route.fetch(new Request('http://localhost/api/jiezi/deploy', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    }));
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'invalid_request');
  } finally {
    await bridge.close();
  }
});

test('apply registers each exact path once against a path-unique registry', { timeout: 10_000 }, async () => {
  const bridge = await startFakeBridge(handlers());
  const registered = new Map();
  const cleanups = [];
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          if (registered.has(route.path)) throw new Error(`duplicate example route ${route.path}`);
          registered.set(route.path, route.methods);
          return () => { registered.delete(route.path); };
        },
      },
    },
    effect(factory, _label) {
      const cleanup = factory();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    assert.equal(registered.size, 9);
    for (const path of Object.values(API_ROUTES)) assert.ok(registered.has(path), `${path} registered`);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    await bridge.close();
  }
});

test('status reports a stopped bridge as an actionable state, not an HTTP error', { timeout: 10_000 }, async () => {
  const { routes } = await contextFor('/tmp/jiezi-dsh-missing-socket.sock');
  const response = await call(routes, 'GET', '/api/jiezi/status');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.bridge.available, false);
  assert.equal(body.bridge.error.code, 'bridge_unavailable');
  assert.match(body.bridge.error.message, /jiezi-bridge is not running/);
  assert.deepEqual(body.devices, []);
});

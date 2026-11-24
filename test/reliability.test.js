import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../lib/tools.js';
import { startFakeBridge } from './support/fake-bridge.js';

function fakeContext() {
  const tools = [];
  const sections = [];
  const cleanups = [];
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    systemPrompt: { section(section) { sections.push(section); return () => {}; } },
    effect(factory) {
      const cleanup = factory();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  return { ctx, tools, sections, cleanups };
}

async function closeAll(cleanups, bridge) {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup?.(); } catch { /* teardown is best effort */ }
  }
  await bridge.close();
}

const DEVICE = {
  deviceId: 'dev_1', name: 'iPhone 15', online: true, developerMode: true, automation: true,
  hostVersion: '0.1.0', targetKind: 'physical',
  activeApp: { appId: 'com.jiezi.demo', releaseId: 'rel_active', instanceId: 'inst_1', installedApps: [] },
};

function baseHandlers(overrides = {}) {
  return {
    'GET /v1/health': () => ({ body: { ok: true, version: '0.3.4' } }),
    'GET /v1/devices': () => ({ body: { ok: true, devices: [DEVICE] } }),
    'GET /v1/ops': () => ({ body: { ok: true, ops: [] } }),
    'GET /v1/events': () => ({ body: {} }),
    ...overrides,
  };
}

function contextFor(bridge) {
  const { ctx, tools, sections, cleanups } = fakeContext();
  apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
  return { tools, sections, cleanups };
}

test('reload and deploy force start a fresh operation', { timeout: 20_000 }, async () => {
  const deploys = [];
  const bridge = await startFakeBridge(baseHandlers({
    'POST /v1/deploy': (body) => {
      deploys.push(body);
      return { body: { ok: true, opId: `op_${deploys.length}`, state: 'pending', reinstalled: true } };
    },
  }));
  const { tools, cleanups } = contextFor(bridge);
  try {
    const reload = await tools.find((tool) => tool.name === 'miniapp')
      .execute({ action: 'reload', deviceId: 'dev_1' }, {});
    assert.equal(reload.ok, true);
    assert.equal(reload.reload, true);
    assert.equal(reload.releaseId, 'rel_active');
    assert.deepEqual(deploys[0], { deviceId: 'dev_1', releaseId: 'rel_active', force: true });

    const deploy = await tools.find((tool) => tool.name === 'miniapp')
      .execute({ action: 'deploy', deviceId: 'dev_1', releaseId: 'rel_active', force: true }, {});
    assert.equal(deploy.ok, true);
    assert.equal(deploys[1].force, true);
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('a deduplicated deploy does not claim a reinstall', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge(baseHandlers({
    'POST /v1/deploy': () => ({
      body: {
        ok: true, opId: 'op_existing', state: 'running',
        deduplicated: true, resent: false, reinstalled: false,
      },
    }),
  }));
  const { tools, cleanups } = contextFor(bridge);
  try {
    const result = await tools.find((tool) => tool.name === 'miniapp')
      .execute({ action: 'deploy', deviceId: 'dev_1', releaseId: 'rel_active' }, {});
    assert.equal(result.deduplicated, true);
    assert.equal(result.reinstalled, false);
    assert.match(result.nextAction, /action: "reload"/);
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('HOST_ALERT_BLOCKING keeps instance identity and routes to a Host update', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge(baseHandlers({
    'POST /v1/automation': (body) => ({
      body: {
        ok: true, deduplicated: false,
        request: {
          requestId: body.action === 'observe' ? 'auto_obs' : 'auto_alert',
          opId: body.opId, deviceId: body.deviceId, action: body.action,
          state: 'pending', appId: body.appId ?? null, instanceId: body.instanceId ?? null,
          snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_alert': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_alert', opId: 'op_alert', deviceId: 'dev_1', action: 'tap',
          state: 'failed', appId: 'com.jiezi.demo', instanceId: 'inst_alert', snapshot: null,
          error: {
            code: 'HOST_ALERT_BLOCKING',
            message: '小程序界面被“运行错误：返回桌面失败：实时界面无法生成冻结快照”弹窗覆盖，点击不会到达页面；请先部署修复后的版本。',
          },
          hostAlert: {
            code: 'HOST_ALERT_BLOCKING',
            message: '运行错误：返回桌面失败：实时界面无法生成冻结快照',
            appId: 'com.jiezi.demo', instanceId: 'inst_alert',
          },
          diagnostics: { cursor: 0, sequences: [], events: [] },
        },
      },
    }),
  }));
  const { tools, cleanups } = contextFor(bridge);
  try {
    const result = await tools.find((tool) => tool.name === 'miniapp_action').execute({
      deviceId: 'dev_1', appId: 'com.jiezi.demo', instanceId: 'inst_alert',
      target: { testID: 'save' },
    }, {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'HOST_ALERT_BLOCKING');
    assert.equal(result.error.category, 'host');
    assert.equal(result.appId, 'com.jiezi.demo');
    assert.equal(result.instanceId, 'inst_alert');
    assert.equal(result.host.version, '0.1.0');
    assert.equal(result.host.minimumVersion, '0.2.0');
    assert.equal(result.host.compatibility, 'outdated');
    assert.match(result.error.message, /宿主 App/);
    assert.match(result.error.message, /不要重复部署/);
    assert.doesNotMatch(result.error.message, /部署修复后的版本/);
    assert.equal(result.runtimeError, null);
    assert.match(result.hostAlert.message, /不要重复部署/);
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('expect.checks asserts progress and hint text in one action', { timeout: 20_000 }, async () => {
  const snapshot = {
    snapshotId: 'snap_checks', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], truncated: false,
    nodes: [
      { alias: '1', testID: 'task-progress', label: '2 / 3', role: 'text', value: null, frame: null, enabled: true, visible: true, path: '0/0' },
      { alias: '2', testID: 'task-hint', label: '已保存', role: 'text', value: null, frame: null, enabled: true, visible: true, path: '0/1' },
    ],
  };
  const bridge = await startFakeBridge(baseHandlers({
    'POST /v1/automation': (body) => ({
      body: {
        ok: true, deduplicated: false,
        request: {
          requestId: 'auto_checks', opId: body.opId, deviceId: body.deviceId, action: body.action,
          state: 'pending', appId: snapshot.appId, instanceId: snapshot.instanceId, snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_checks': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_checks', opId: 'op_checks', deviceId: 'dev_1', action: 'tap',
          state: 'done', appId: snapshot.appId, instanceId: snapshot.instanceId, snapshot,
          error: null, diagnostics: { cursor: 0, sequences: [], events: [] },
        },
      },
    }),
  }));
  const { tools, cleanups } = contextFor(bridge);
  try {
    const action = tools.find((tool) => tool.name === 'miniapp_action');
    const passed = await action.execute({
      deviceId: 'dev_1', target: { testID: 'task-progress' },
      expect: {
        checks: [
          { testID: 'task-progress', textContains: '2 / 3' },
          { testID: 'task-hint', textEquals: '已保存' },
        ],
      },
    }, {});
    assert.equal(passed.ok, true);
    assert.equal(passed.verification.passed, true);

    const failed = await action.execute({
      deviceId: 'dev_1', target: { testID: 'task-progress' },
      expect: { checks: [{ testID: 'task-progress', textContains: '3 / 3' }] },
    }, {});
    assert.equal(failed.ok, false);
    assert.equal(failed.verification.passed, false);
    assert.match(failed.verification.reason, /task-progress/);
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('hidden recycled rows are dropped and can be opted back in', { timeout: 20_000 }, async () => {
  const snapshot = {
    snapshotId: 'snap_hidden', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], truncated: false,
    nodes: [
      { alias: '1', testID: 'task-row-1', label: '买牛奶', role: 'button', value: null, frame: null, enabled: true, visible: true, path: '0/0' },
      { alias: '2', testID: 'task-row-1', label: '买牛奶', role: 'button', value: null, frame: null, enabled: true, visible: false, path: '0/1' },
      { alias: '3', testID: 'task-hint', label: '总进度 1 / 3', role: 'text', value: null, frame: null, enabled: true, visible: true, path: '0/2' },
      { alias: '4', testID: 'task-row-2', label: '旧行', role: 'button', value: null, frame: null, enabled: true, visible: false, path: '0/3' },
    ],
  };
  const bridge = await startFakeBridge(baseHandlers({
    'POST /v1/automation': (body) => ({
      body: {
        ok: true, deduplicated: false,
        request: {
          requestId: 'auto_hidden', opId: body.opId, deviceId: body.deviceId, action: 'observe',
          state: 'pending', appId: snapshot.appId, instanceId: snapshot.instanceId, snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_hidden': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_hidden', opId: 'op_hidden', deviceId: 'dev_1', action: 'observe',
          state: 'done', appId: snapshot.appId, instanceId: snapshot.instanceId, snapshot,
          error: null, diagnostics: { cursor: 0, sequences: [], events: [] },
        },
      },
    }),
  }));
  const { tools, cleanups } = contextFor(bridge);
  try {
    const ui = tools.find((tool) => tool.name === 'miniapp_ui');
    const visible = await ui.execute({ deviceId: 'dev_1' }, {});
    const occurrences = visible.outline.split('task-row-1').length - 1;
    assert.equal(occurrences, 1, 'the hidden duplicate testID is not rendered twice');
    assert.equal(visible.outline.includes('task-row-2'), false);
    assert.match(visible.outline, /1 hidden omitted/);
    assert.equal(visible.snapshotIssues.visibleNodeCount, 2);
    assert.equal(visible.snapshotIssues.hiddenNodeCount, 1);

    const all = await ui.execute({ deviceId: 'dev_1', includeHidden: true }, {});
    assert.match(all.outline, /task-row-2/);
    assert.match(all.outline, /hidden/);
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('the device action returns the unified device list', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge(baseHandlers());
  const { tools, cleanups } = contextFor(bridge);
  try {
    const result = await tools.find((tool) => tool.name === 'miniapp').execute({ action: 'device' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.devices.length, 1);
    assert.equal(result.devices[0].jieziPaired, true);
    assert.ok(result.devices[0].coreDevicePaired === null || typeof result.devices[0].coreDevicePaired === 'boolean');
    assert.equal(result.devices[0].hostRunning, true);
    assert.equal(result.devices[0].hostVersion, '0.1.0');
    assert.equal(result.devices[0].hostCompatibility, 'outdated');
    assert.equal(result.devices[0].hostMinimumVersion, '0.2.0');
    assert.ok(Array.isArray(result.targets));
    assert.ok(Array.isArray(result.bindings));
  } finally {
    await closeAll(cleanups, bridge);
  }
});

test('doctor returns a bounded readiness report without starting the bridge', { timeout: 30_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-doctor-tool-'));
  const bridge = await startFakeBridge(baseHandlers({
    'GET /v1/health': () => ({ body: { ok: true, version: '0.3.4', socket: '/tmp/bridge.sock', pid: 42 } }),
  }));
  const { ctx, tools, cleanups } = fakeContext();
  apply(ctx, { socketPath: bridge.socketPath, stateDir, timeoutMs: 2_000 });
  try {
    const result = await tools.find((tool) => tool.name === 'miniapp').execute({ action: 'doctor' }, {});
    assert.equal(result.ok, true);
    assert.equal(typeof result.ready, 'boolean');
    assert.ok(Array.isArray(result.blockers));
    assert.ok(Array.isArray(result.nextActions));
    assert.equal(result.host.minimumVersion, '0.2.0');
    assert.equal(result.bridge.running, true);
    assert.equal(result.bridge.version, '0.3.4');
    assert.equal(bridge.requests.some((request) => request.method === 'POST'), false);
  } finally {
    await closeAll(cleanups, bridge);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

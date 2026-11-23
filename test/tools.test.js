import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../lib/tools.js';
import { startFakeBridge } from './support/fake-bridge.js';

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(predicate, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('condition was not met before the deadline');
}

function fakeContext(initialSections = [], sandboxPolicy) {
  const tools = [];
  const sections = [...initialSections];
  const cleanups = [];
  const ctx = {
    ...(sandboxPolicy === undefined ? {} : {
      get(name) { return name === 'sandboxPolicy' ? sandboxPolicy : undefined; },
    }),
    tools: { register(definition) { tools.push(definition); return () => {}; } },
    systemPrompt: { section(section) {
      sections.push(section);
      return () => {
        const index = sections.indexOf(section);
        if (index >= 0) sections.splice(index, 1);
      };
    } },
    effect(factory) {
      const cleanup = factory();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  return { ctx, tools, sections, cleanups };
}

const snapshot = {
  snapshotId: 'snap_1', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
  mode: 'semantic', capabilities: ['tap'], truncated: false,
  nodes: [
    { alias: '0', testID: 'save', label: '保存', role: 'button', value: null, frame: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, visible: true, path: '0/0' },
    { alias: '1', testID: 'title', label: '芥子', role: 'text', value: null, frame: null, enabled: true, visible: true, path: '0/1' },
  ],
};

function handlers(captureTrees) {
  return {
    'GET /v1/health': () => ({ body: { ok: true, version: '0.2.0' } }),
    'POST /v1/projects/init': (body) => ({ body: { ok: true, projectId: body.projectId, projectDir: `/tmp/jiezi-projects/${body.projectId}`, name: body.name ?? body.projectId, appId: body.appId ?? 'com.jiezi.miniapp.demo', template: 'jiezi-basic@1', adapter: 'jiezi/native@0.2.0', files: ['App.tsx'] } }),
    'GET /v1/devices': () => ({
      body: {
        ok: true,
        devices: [{ deviceId: 'dev_1', name: 'iPhone 15', online: true, developerMode: true, automation: true }],
      },
    }),
    'POST /v1/deploy': () => ({ body: { ok: true, opId: 'op_1', state: 'pending' } }),
    'GET /v1/ops/op_1': () => ({ body: { ok: true, op: { opId: 'op_1', deviceId: 'dev_1', releaseId: 'rel_1', state: 'running' } } }),
    'POST /v1/capture': () => ({ body: { ok: true, requestId: 'cap_1', state: 'pending' } }),
    'GET /v1/captures/cap_1': () => ({
      body: {
        ok: true,
        capture: {
          requestId: 'cap_1', state: 'done', deviceId: 'dev_1',
          result: { tree: captureTrees.value, screenshotPath: '/tmp/cap_1.png' },
        },
      },
    }),
    'POST /v1/automation': (body) => ({
      body: {
        ok: true,
        deduplicated: false,
        request: {
          requestId: body.action === 'observe' ? 'auto_obs' : 'auto_tap',
          opId: body.opId, deviceId: body.deviceId, action: body.action,
          state: 'pending', appId: 'com.jiezi.demo', instanceId: 'inst_1', snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_obs': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_obs', opId: 'op_auto_1', deviceId: 'dev_1', action: 'observe', state: 'done',
          appId: 'com.jiezi.demo', instanceId: 'inst_1', error: null, snapshot,
          diagnostics: { cursor: 7, sequences: [7] },
        },
      },
    }),
    'GET /v1/automation/auto_tap': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_tap', opId: 'op_auto_2', deviceId: 'dev_1', action: 'tap', state: 'failed',
          appId: 'com.jiezi.demo', instanceId: 'inst_1', snapshot: null,
          error: { code: 'target_not_found', message: 'no unique visible target matched' },
        },
      },
    }),
    'GET /v1/events': () => ({ body: {} }),
  };
}

test('preset registers twelve bounded tools, a prompt section, and the sidebar hooks', { timeout: 20_000 }, async () => {
  const trees = { value: { role: 'root' } };
  const bridge = await startFakeBridge(handlers(trees), {
    events: 'event: status\ndata: {"opId":"op_1","state":"running"}\n\n',
    triggerOn: 'POST /v1/deploy',
  });
  const { ctx, tools, sections, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'miniapp_action', 'miniapp_build', 'miniapp_capture', 'miniapp_deploy',
      'miniapp_device', 'miniapp_devices', 'miniapp_diagnostics', 'miniapp_init', 'miniapp_open',
      'miniapp_screen', 'miniapp_status', 'miniapp_ui',
    ]);
    assert.equal(sections.length, 1);
    assert.match(sections[0].text, /host-component/);
    assert.match(sections[0].text, /miniapp_ui/);
    assert.match(sections[0].text, /jiezi-miniapp/);
    assert.match(sections[0].text, /components\.md/);
    assert.match(sections[0].text, /user action/);

    const byName = (name) => tools.find((tool) => tool.name === name);

    const initialized = await byName('miniapp_init').execute({ projectId: 'demo', name: 'Demo', appId: 'com.example.demo' }, {});
    assert.equal(initialized.ok, true);
    assert.equal(initialized.projectId, 'demo');
    assert.equal(initialized.projectDir, '/tmp/jiezi-projects/demo');
    assert.equal(initialized.template, 'jiezi-basic@1');

    const devices = await byName('miniapp_devices').execute({}, {});
    assert.equal(devices.ok, true);
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].deviceId, 'dev_1');
    assert.equal(devices.devices[0].online, true);
    assert.equal(devices.devices[0].developerMode, true);
    assert.equal(devices.devices[0].automation, true);

    const observes = await byName('miniapp_ui').execute({ deviceId: 'dev_1' }, {});
    assert.equal(observes.ok, true);
    assert.equal(observes.state, 'done');
    assert.equal(observes.action, 'observe');
    assert.equal(observes.nodeCount, 2);
    assert.match(observes.outline, /testID="save"/);
    assert.equal(observes.outline.includes('"nodes"'), false);
    assert.equal(observes.diagnosticCursor, 7);
    assert.deepEqual(observes.diagnostics, { cursor: 7, sequences: [7], events: [] });

    const tap = await byName('miniapp_action').execute({
      deviceId: 'dev_1', target: { testID: 'save' }, expect: { visibleLabel: '保存' },
    }, {});
    assert.equal(tap.ok, false);
    assert.equal(tap.state, 'failed');
    assert.deepEqual(tap.error, { code: 'target_not_found', message: 'no unique visible target matched' });

    const capture = await byName('miniapp_capture').execute({ deviceId: 'dev_1', waitMs: 1_000 }, {});
    assert.equal(capture.ok, true);
    assert.equal(capture.state, 'done');
    assert.deepEqual(capture.tree, { role: 'root' });
    assert.equal(capture.screenshotPath, '/tmp/cap_1.png');

    trees.value = { rows: Array.from({ length: 200 }, (_, index) => ({ id: `row-${index}`, title: 'x'.repeat(80) })) };
    const large = await byName('miniapp_capture').execute({ deviceId: 'dev_1', waitMs: 1_000 }, {});
    assert.equal(large.ok, true);
    assert.equal(large.tree, null);
    assert.equal(large.treeTruncated, true);
    assert.ok(large.treeChars > 12_000);
    assert.equal(large.screenshotPath, '/tmp/cap_1.png');

    const reread = await byName('miniapp_capture').execute({ deviceId: 'dev_1', requestId: 'cap_1', waitMs: 1_000 }, {});
    assert.equal(reread.ok, true);
    assert.equal(reread.state, 'done');
    assert.equal(reread.requestId, 'cap_1');

    const diagnostics = await byName('miniapp_diagnostics').execute({}, {});
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.code, 'invalid_request');

    const invalid = await byName('miniapp_deploy').execute(null, {});
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'invalid_request');

    const followups = [];
    const injects = [];
    const deployed = await byName('miniapp_deploy').execute({ deviceId: 'dev_1', releaseId: 'rel_1' }, {
      agent: {
        status: 'idle',
        followup(message) { followups.push(message); },
        inject(message) { injects.push(message); },
      },
    });
    assert.equal(deployed.ok, true);
    const deadline = Date.now() + 2_000;
    while (followups.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(followups.length, 1);
    assert.equal(injects.length, 0);
    assert.match(followups[0].content[0].text, /JieZi delivery update for op_1: running/);
    assert.match(followups[0].content[0].text, /miniapp_ui/);
    assert.deepEqual(followups[0].source, {
      kind: 'jiezi-delivery', form: 'notice', summary: 'deploy op_1 running', opId: 'op_1', state: 'running',
    });
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('JieZi guidance adds a non-exclusive section and preserves the standard prompt', async () => {
  const bridge = await startFakeBridge(handlers({ value: { role: 'root' } }));
  const standard = {
    name: 'deployment:persona-prefix', order: 0,
    text: 'You are a coding agent powered by the standard model.',
  };
  const { ctx, sections, cleanups } = fakeContext([standard]);
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    assert.equal(sections.length, 2);
    assert.equal(sections[0], standard, 'the existing standard section is untouched');
    const jiezi = sections[1];
    assert.equal(jiezi.name, 'jiezi-delivery');
    assert.equal(jiezi.complete, undefined, 'ordinary additive section, never a complete override');
    assert.equal(jiezi.interpolate, false);
    assert.match(jiezi.retirement, /no longer apply/);
    assert.match(jiezi.text, /supplement the standard Agent guidance/);
    assert.match(jiezi.text, /miniapp_init/);
    assert.match(jiezi.text, /components\.md/);
    assert.match(jiezi.text, /miniapp_status/);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
  assert.deepEqual(sections, [standard], 'unloading JieZi reveals the unchanged standard section');
});

test('miniapp_action returns the computed verification and diagnostic cursor', { timeout: 20_000 }, async () => {
  const snapshot = {
    snapshotId: 'snap_ok', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], truncated: false,
    nodes: [
      { alias: '1', testID: 'save', label: '保存', role: 'button', value: null, frame: null, enabled: true, visible: true, path: '0/0' },
    ],
  };
  const bridge = await startFakeBridge({
    ...handlers({ value: null }),
    'POST /v1/automation': () => ({
      body: {
        ok: true,
        deduplicated: false,
        request: {
          requestId: 'auto_ok', opId: 'op_ok', deviceId: 'dev_1', action: 'tap',
          state: 'pending', appId: 'com.jiezi.demo', instanceId: 'inst_1', snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_ok': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_ok', opId: 'op_ok', deviceId: 'dev_1', action: 'tap', state: 'done',
          appId: 'com.jiezi.demo', instanceId: 'inst_1', error: null, snapshot,
          diagnostics: {
            cursor: 41,
            sequences: [40, 41],
            events: [{
              sequence: 41,
              level: 'error',
              code: 'NSH_UNCAUGHT_ERROR',
              message: 'probe handler failure',
              timestamp: '2026-11-22T03:52:32Z',
            }],
          },
          hostAlert: {
            code: 'RUNTIME_ERROR_ALERT',
            message: '小程序运行错误：probe handler failure',
            appId: 'com.jiezi.demo',
            instanceId: 'inst_1',
          },
        },
      },
    }),
  });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const result = await tools.find((tool) => tool.name === 'miniapp_action').execute({
      deviceId: 'dev_1',
      target: { testID: 'save' },
      expect: { visibleTestID: 'save', textContains: '保存' },
    }, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.verification, { passed: true, reason: null });
    assert.equal(result.diagnosticCursor, 41);
    assert.equal(result.diagnostics.events[0].code, 'NSH_UNCAUGHT_ERROR');
    assert.equal(result.runtimeError.code, 'NSH_UNCAUGHT_ERROR');
    assert.equal(result.hostAlert.code, 'RUNTIME_ERROR_ALERT');
    assert.equal(result.hostAlert.instanceId, 'inst_1');
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('tool calls report bridge failures as structured, actionable results', { timeout: 15_000 }, async () => {
  const bridge = await startFakeBridge({
    ...handlers({ value: null }),
    'POST /v1/automation': () => ({
      status: 409,
      body: { ok: false, error: { code: 'device_offline', message: 'device is not connected' } },
    }),
  });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const ui = tools.find((tool) => tool.name === 'miniapp_ui');
    const result = await ui.execute({ deviceId: 'dev_1' }, {});
    assert.deepEqual(result, {
      ok: false,
      code: 'device_offline',
      message: 'device is not connected',
      retryable: true,
    });
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('a busy Agent is injected with a labelled delivery notice', { timeout: 20_000 }, async () => {
  let streamReady = false;
  const bridge = await startFakeBridge(handlers({ value: null }), {
    events: 'event: status\ndata: {"opId":"op_1","state":"failed","failureLayer":"runtime","evidenceId":"ev_1"}\n\n',
    triggerOn: 'POST /v1/deploy',
    onStream() { streamReady = true; },
  });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    await waitFor(() => streamReady);
    const deploy = tools.find((tool) => tool.name === 'miniapp_deploy');
    const followups = [];
    const injects = [];
    const deployed = await deploy.execute({ deviceId: 'dev_1', releaseId: 'rel_1' }, {
      agent: {
        status: 'running',
        followup(message) { followups.push(message); },
        inject(message) { injects.push(message); },
      },
    });
    assert.equal(deployed.ok, true);
    await waitFor(() => injects.length > 0);
    assert.equal(followups.length, 0);
    assert.equal(injects.length, 1);
    assert.match(injects[0].content[0].text, /JieZi delivery update for op_1: failed \(runtime\)/);
    assert.match(injects[0].content[0].text, /Evidence id: ev_1/);
    assert.deepEqual(injects[0].source, {
      kind: 'jiezi-delivery',
      form: 'notice',
      summary: 'deploy op_1 failed',
      opId: 'op_1',
      state: 'failed',
      failureLayer: 'runtime',
      evidenceId: 'ev_1',
    });
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('miniapp_status wait returns the terminal record and suppresses the notice', { timeout: 20_000 }, async () => {
  const opState = { value: 'pending' };
  let emit = null;
  const bridge = await startFakeBridge({
    ...handlers({ value: null }),
    'POST /v1/deploy': () => ({ body: { ok: true, opId: 'op_wait', state: 'pending' } }),
    'GET /v1/ops/op_wait': () => ({
      body: { ok: true, op: { opId: 'op_wait', deviceId: 'dev_1', releaseId: 'rel_1', state: opState.value } },
    }),
  }, { onStream(write) { emit = write; } });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const byName = (name) => tools.find((tool) => tool.name === name);
    const followups = [];
    const injects = [];
    const agent = {
      status: 'running',
      followup(message) { followups.push(message); },
      inject(message) { injects.push(message); },
    };
    const deployed = await byName('miniapp_deploy').execute({ deviceId: 'dev_1', releaseId: 'rel_1' }, { agent });
    assert.equal(deployed.ok, true);

    const pending = byName('miniapp_status').execute(
      { opId: 'op_wait', wait: true, timeoutMs: 5_000 },
      { agent, signal: new AbortController().signal },
    );
    await waitFor(() => emit !== null && bridge.requests.some((request) => request.path === '/v1/ops/op_wait'));
    opState.value = 'running';
    emit('event: status\ndata: {"opId":"op_wait","state":"running"}\n\n');

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.op.state, 'running');
    assert.equal(injects.length, 0);
    assert.equal(followups.length, 0);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('a timed-out or cancelled wait reports the current state without waking the Agent', { timeout: 20_000 }, async () => {
  const bridge = await startFakeBridge({
    ...handlers({ value: null }),
    'GET /v1/ops/op_slow': () => ({
      body: { ok: true, op: { opId: 'op_slow', deviceId: 'dev_1', releaseId: 'rel_1', state: 'downloading' } },
    }),
  });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const status = tools.find((tool) => tool.name === 'miniapp_status');

    const started = Date.now();
    const timedOut = await status.execute({ opId: 'op_slow', wait: true, timeoutMs: 1_000 }, {});
    assert.ok(Date.now() - started >= 900);
    assert.equal(timedOut.ok, true);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.op.state, 'downloading');

    const controller = new AbortController();
    const waiting = status.execute(
      { opId: 'op_slow', wait: true, timeoutMs: 5_000 },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('cancelled by test')), 50);
    await assert.rejects(waiting, /cancelled by test/);

    const noOp = await status.execute({ wait: true }, {});
    assert.equal(noOp.ok, false);
    assert.equal(noOp.code, 'invalid_request');
    const badTimeout = await status.execute({ opId: 'op_slow', wait: true, timeoutMs: 10 }, {});
    assert.equal(badTimeout.ok, false);
    assert.equal(badTimeout.code, 'invalid_request');
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('miniapp_action type forwards text and renders the fresh field value', { timeout: 20_000 }, async () => {
  const snapshot = {
    snapshotId: 'snap_type', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap', 'type'], truncated: false,
    nodes: [
      {
        alias: '1', testID: 'name', label: '占位符：名称', role: 'textField',
        value: '自动化输入', focused: true, frame: { x: 10, y: 20, width: 200, height: 44 },
        enabled: true, visible: true, path: 'modal0/0/0',
      },
    ],
  };
  const bridge = await startFakeBridge({
    ...handlers({ value: null }),
    'POST /v1/automation': (body) => ({
      body: {
        ok: true,
        deduplicated: false,
        request: {
          requestId: 'auto_type', opId: body.opId, deviceId: 'dev_1', action: 'type',
          state: 'pending', appId: 'com.jiezi.demo', instanceId: 'inst_1', snapshot: null, error: null,
        },
      },
    }),
    'GET /v1/automation/auto_type': () => ({
      body: {
        ok: true,
        request: {
          requestId: 'auto_type', opId: 'op_type', deviceId: 'dev_1', action: 'type', state: 'done',
          appId: 'com.jiezi.demo', instanceId: 'inst_1', error: null, snapshot,
          diagnostics: { cursor: 0, sequences: [], events: [] },
          hostAlert: null,
        },
      },
    }),
  });
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const result = await tools.find((tool) => tool.name === 'miniapp_action').execute({
      deviceId: 'dev_1',
      action: 'type',
      target: { testID: 'name' },
      text: '自动化输入',
      replace: true,
      includeFrames: true,
      expect: { visibleTestID: 'name', textContains: '自动化' },
    }, {});
    assert.equal(result.ok, true);
    assert.equal(result.action, 'type');
    assert.equal(result.verification.passed, true);
    assert.match(result.outline, /value="自动化输入"/);
    assert.match(result.outline, /focused/);
    assert.match(result.outline, /frame=10,20 200x44/);
    const sent = bridge.requests.filter((request) => request.method === 'POST' && request.path === '/v1/automation').at(-1);
    assert.equal(sent.body.action, 'type');
    assert.equal(sent.body.target.testID, 'name');
    assert.equal(sent.body.text, '自动化输入');
    assert.equal(sent.body.replace, true);
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

test('init and build target the Session working directory', { timeout: 20_000 }, async () => {
  const trees = { value: { role: 'root' } };
  const bridge = await startFakeBridge(handlers(trees));
  const { ctx, tools, cleanups } = fakeContext();
  try {
    apply(ctx, { socketPath: bridge.socketPath, timeoutMs: 2_000 });
    const session = { header: { cwd: '/Users/someone/work/demo' } };
    const exec = { agent: { session } };
    await tools.find((tool) => tool.name === 'miniapp_init')
      .execute({ projectId: 'demo' }, exec);
    await tools.find((tool) => tool.name === 'miniapp_build')
      .execute({ projectId: 'demo' }, exec);

    const init = bridge.requests.find((request) => request.method === 'POST' && request.path === '/v1/projects/init');
    assert.equal(init.body.root, '/Users/someone/work/demo');
    const build = bridge.requests.find((request) => request.method === 'POST' && request.path === '/v1/build');
    assert.equal(build.body.root, '/Users/someone/work/demo');

    await tools.find((tool) => tool.name === 'miniapp_init').execute({ projectId: 'other' }, undefined);
    const agentless = bridge.requests.filter((request) => request.method === 'POST' && request.path === '/v1/projects/init').at(-1);
    assert.equal('root' in agentless.body, false, 'an agentless call sends no root');
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup?.(); } catch { /* teardown is best effort */ }
    }
    await bridge.close();
  }
});

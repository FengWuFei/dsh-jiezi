import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_ROUTES,
  MAX_OUTLINE_CHARS,
  automationDiagnostics,
  evaluateExpectation,
  formatOutline,
  parseAutomationArgs,
  parseCaptureArgs,
  parseDeployArgs,
  parseDiagnosticsArgs,
  parseInitArgs,
  pairingPayloadText,
  validatePairingPayload,
} from '../lib/shared/protocol.js';

const payload = {
  schema: 'jiezi.pairing.v1',
  sessionId: 'pair_abc',
  endpoint: 'wss://192.168.1.5:7331/device',
  code: 'ABCDEFGH',
  certificateFingerprint: 'a'.repeat(64),
  expiresAt: '2026-11-21T12:00:00.000Z',
};

test('project init arguments are bounded and preserve only the public fields', () => {
  assert.deepEqual(parseInitArgs({ projectId: 'todo-list', name: 'Todo List', appId: 'com.example.todo' }), {
    projectId: 'todo-list', name: 'Todo List', appId: 'com.example.todo',
  });
  assert.deepEqual(parseInitArgs({ projectId: 'todo-list' }), { projectId: 'todo-list' });
  assert.throws(() => parseInitArgs({}), /projectId/);
  assert.throws(() => parseInitArgs({ projectId: 'x'.repeat(49) }), /projectId/);
  assert.throws(() => parseInitArgs({ projectId: 'valid', appId: 'x'.repeat(129) }), /appId/);
});

test('pairing payload carries exactly the six agreed fields', () => {
  const value = validatePairingPayload(payload);
  assert.deepEqual(Object.keys(value).sort(), [
    'certificateFingerprint', 'code', 'endpoint', 'expiresAt', 'schema', 'sessionId',
  ]);
  assert.equal(pairingPayloadText(value), JSON.stringify(payload));
  assert.throws(() => validatePairingPayload({ ...payload, extra: true }), /exactly/);
  assert.throws(() => validatePairingPayload({ ...payload, schema: 'jiezi.pairing.v2' }), /schema/);
  assert.throws(() => validatePairingPayload({ ...payload, expiresAt: 'later' }), /expiresAt/);
  assert.throws(() => validatePairingPayload({ ...payload, sessionId: '' }), /sessionId/);
  assert.equal(validatePairingPayload({ ...payload, certificateFingerprint: null }).certificateFingerprint, null);
});

test('automation tap arguments normalize one target and assertion set', () => {
  const parsed = parseAutomationArgs('tap', {
    deviceId: 'dev_1',
    opId: 'op_1',
    target: { testID: 'save', role: 'button' },
    expect: { visibleLabel: 'Saved', textContains: 'saved' },
    timeoutMs: 9_000,
  });
  assert.deepEqual(parsed.target, { testID: 'save', role: 'button' });
  assert.deepEqual(parsed.expect, { visibleLabel: 'Saved', textContains: 'saved' });
  assert.equal(parsed.timeoutMs, 9_000);
  assert.equal(parsed.action, 'tap');
  assert.throws(() => parseAutomationArgs('tap', { deviceId: 'dev_1', opId: 'op_1', target: {} }), /target requires/);
  assert.throws(() => parseAutomationArgs('tap', { deviceId: 'dev_1', opId: 'op_1' }), /target/);
  assert.throws(() => parseAutomationArgs('observe', { deviceId: '', opId: 'op_1' }), /deviceId/);
});

test('scroll arguments normalize direction, amount and target', () => {
  const parsed = parseAutomationArgs('scroll', {
    deviceId: 'dev_1',
    opId: 'op_1',
    target: { alias: 'n1' },
    direction: 'up',
    amount: 0.5,
    includeFrames: true,
  });
  assert.equal(parsed.action, 'scroll');
  assert.deepEqual(parsed.target, { alias: 'n1' });
  assert.equal(parsed.direction, 'up');
  assert.equal(parsed.amount, 0.5);
  assert.equal(parsed.includeFrames, true);
  assert.throws(
    () => parseAutomationArgs('scroll', { deviceId: 'dev_1', opId: 'op_1', target: { testID: 'x' }, direction: 'sideways' }),
    /direction/,
  );
  const clamped = parseAutomationArgs('scroll', { deviceId: 'dev_1', opId: 'op_1', target: { testID: 'x' }, amount: 0 });
  assert.equal(clamped.amount, 0.1);
});

test('observe arguments ignore target and clamp the timeout', () => {
  const parsed = parseAutomationArgs('observe', { deviceId: 'dev_1', opId: 'op_1', timeoutMs: 999_999 });
  assert.equal(parsed.target, undefined);
  assert.equal(parsed.timeoutMs, 30_000);
  assert.equal(parseCaptureArgs({ deviceId: 'dev_1', waitMs: -5 }).waitMs, 0);
  assert.equal(parseCaptureArgs({ deviceId: 'dev_1' }).waitMs, 5_000);
  assert.equal(parseCaptureArgs({ deviceId: 'dev_1', requestId: 'cap_1' }).requestId, 'cap_1');
  assert.deepEqual(parseDeployArgs({ deviceId: 'dev_1', releaseId: 'rel_1' }), { deviceId: 'dev_1', releaseId: 'rel_1' });
  assert.throws(() => parseDiagnosticsArgs({}), /opId or evidenceId/);
});

test('expectations scope text checks to the expected testID', () => {
  const snapshot = {
    snapshotId: 'snap_1', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], truncated: false,
    nodes: [
      { alias: 'n1', testID: 'demo.screen', label: 'pressed 0 +1', value: null, role: 'view', frame: null, enabled: true, visible: true, path: 'root' },
      { alias: 'n2', testID: 'demo.count', label: '0', value: null, role: 'view', frame: null, enabled: true, visible: true, path: 'root/1' },
    ],
  };
  const failed = evaluateExpectation({ visibleTestID: 'demo.count', textContains: '1' }, snapshot);
  assert.equal(failed.passed, false);
  assert.match(failed.reason, /demo\.count/);
  assert.equal(evaluateExpectation({ visibleTestID: 'demo.count', textContains: '0' }, snapshot).passed, true);
  assert.equal(evaluateExpectation({ textContains: '+1' }, snapshot).passed, true);
  assert.equal(evaluateExpectation({ visibleLabel: 'Missing' }, snapshot).passed, false);
});

test('outline formatting is compact and bounded', () => {
  const nodes = Array.from({ length: 300 }, (_, index) => ({
    alias: String(index),
    testID: `control-${index}`,
    label: `Label ${index}`,
    role: 'button',
    value: null,
    frame: { x: index, y: index, width: 10, height: 10 },
    enabled: true,
    visible: index % 10 !== 0,
    path: `0/${index}`,
  }));
  const outline = formatOutline({
    snapshotId: 'snap_1', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], screen: { width: 402, height: 874 },
    nodes, truncated: true,
  }, { frames: true });
  assert.match(outline, /^snapshot snap_1 app=com\.jiezi\.demo instance=inst_1 mode=semantic screen=402x874 nodes=300 \(truncated\)/);
  assert.match(outline, /testID="control-0"/);
  assert.match(outline, /frame=1,1 10x10/);
  assert.match(outline, /hidden/);
  const compact = formatOutline({
    snapshotId: 'snap_1', appId: 'com.jiezi.demo', releaseId: 'rel_1', instanceId: 'inst_1',
    mode: 'semantic', capabilities: ['tap'], screen: { width: 402, height: 874 },
    nodes, truncated: true,
  });
  assert.doesNotMatch(compact, /screen=|frame=/);
  assert.ok(outline.length <= MAX_OUTLINE_CHARS);
  assert.match(outline, /more nodes omitted/);
});

test('API routes are exact absolute paths under /api/jiezi', () => {
  for (const route of Object.values(API_ROUTES)) {
    assert.match(route, /^\/api\/jiezi\/[a-z]+$/);
  }
  assert.deepEqual(API_ROUTES, {
    status: '/api/jiezi/status',
    setup: '/api/jiezi/setup',
    pairing: '/api/jiezi/pairing',
    devices: '/api/jiezi/devices',
    deploy: '/api/jiezi/deploy',
    operation: '/api/jiezi/operation',
    diagnostics: '/api/jiezi/diagnostics',
    automation: '/api/jiezi/automation',
    unpair: '/api/jiezi/unpair',
  });
});

test('automation diagnostics are bounded and expose a cursor', () => {
  assert.deepEqual(automationDiagnostics({ cursor: 12, sequences: [12, 13, 13] }), {
    cursor: 12,
    sequences: [12, 13, 13],
    events: [],
  });
  const many = automationDiagnostics({ cursor: 99, sequences: Array.from({ length: 100 }, (_, index) => index) });
  assert.equal(many.cursor, 99);
  assert.equal(many.sequences.length, 60);
  assert.equal(automationDiagnostics(null), null);
  assert.deepEqual(automationDiagnostics({ cursor: -4, sequences: ['x', 3] }), {
    cursor: 0,
    sequences: [0, 3],
    events: [],
  });
  const withEvents = automationDiagnostics({
    cursor: 4,
    sequences: [5],
    events: [{
      sequence: 5,
      level: 'error',
      code: 'NSH_UNCAUGHT_ERROR',
      message: 'probe handler failure',
      timestamp: '2026-11-22T03:52:32Z',
    }],
  });
  assert.equal(withEvents.events[0].code, 'NSH_UNCAUGHT_ERROR');
  assert.equal(withEvents.events[0].message, 'probe handler failure');
});

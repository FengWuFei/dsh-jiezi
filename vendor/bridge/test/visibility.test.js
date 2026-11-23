// 018: evidence summaries and automation payloads must name the failure of the
// deployment they belong to, not the oldest error in an archive.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundAutomationDiagnostics,
  boundHostAlert,
  summarizeReport,
} from '../src/bridge.js';

test('summarizeReport prefers the explicit failure and keeps its code', () => {
  const summary = summarizeReport({
    failure: { layer: 'runtime', code: 'STARTUP_RUNTIME_ERROR', message: '启动后立即出现运行错误：boom' },
    events: [{ sequence: 9, level: 'error', code: 'NSH_UNCAUGHT_ERROR', message: 'older' }],
  }, 'runtime');
  assert.equal(summary.failureLayer, 'runtime');
  assert.equal(summary.code, 'STARTUP_RUNTIME_ERROR');
  assert.match(summary.message, /boom/);
});

test('summarizeReport reports the newest error event, not the first', () => {
  const summary = summarizeReport({
    events: [
      { sequence: 2, level: 'error', code: 'E_OLD', message: 'old crash', timestamp: '2026-11-22T03:49:24Z' },
      { sequence: 3, level: 'info', message: 'started' },
      { sequence: 4, level: 'error', code: 'E_NEW', message: 'new crash', timestamp: '2026-11-22T03:52:32Z' },
    ],
  }, 'runtime');
  assert.equal(summary.code, 'E_NEW');
  assert.equal(summary.message, 'new crash');
  assert.equal(summary.failureLayer, 'runtime');
});

test('summarizeReport leaves a healthy report without an error', () => {
  const summary = summarizeReport({
    events: [
      { sequence: 1, level: 'info', message: 'started' },
      { sequence: 2, level: 'notice', message: 'loaded' },
    ],
  }, null);
  assert.deepEqual(summary, { failureLayer: null, code: null, message: null });
});

test('automation diagnostics keep bounded event bodies', () => {
  const diagnostics = boundAutomationDiagnostics({
    cursor: 7,
    sequences: [8],
    events: [{
      sequence: 8,
      level: 'error',
      code: 'NSH_UNCAUGHT_ERROR',
      message: 'probe handler failure',
      timestamp: '2026-11-22T03:52:32Z',
    }],
  });
  assert.equal(diagnostics.cursor, 7);
  assert.deepEqual(diagnostics.sequences, [8]);
  assert.equal(diagnostics.events.length, 1);
  assert.equal(diagnostics.events[0].code, 'NSH_UNCAUGHT_ERROR');
  assert.equal(diagnostics.events[0].message, 'probe handler failure');
});

test('automation hostAlert is bounded and nullable', () => {
  assert.equal(boundHostAlert(null), null);
  const alert = boundHostAlert({
    code: 'RUNTIME_ERROR_ALERT',
    message: '小程序运行错误：boom',
    appId: 'com.jiezi.debug.probe',
    releaseId: 'rel_0123456789abcdef_5',
    instanceId: 'C2306A6B-90AE-4F72-8958-7F89F69AD2F8',
    ignored: 'x',
  });
  assert.equal(alert.code, 'RUNTIME_ERROR_ALERT');
  assert.equal(alert.appId, 'com.jiezi.debug.probe');
  assert.equal(alert.instanceId, 'C2306A6B-90AE-4F72-8958-7F89F69AD2F8');
  assert.equal('ignored' in alert, false);
});

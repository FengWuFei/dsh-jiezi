import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseIdFor } from '../src/build.js';
import {
  MAX_EVIDENCE_EVENTS,
  boundReport,
  canTransition,
  classifyFailure,
  hashToken,
  opIdFor,
  parseBuildErrors,
} from '../src/protocol.js';

test('opId is deterministic per release and device', () => {
  const a = opIdFor('rel_abc', 'dev_1');
  const b = opIdFor('rel_abc', 'dev_1');
  const c = opIdFor('rel_abc', 'dev_2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^op_[0-9a-f]{16}$/);
});

test('status transitions move forward and never back', () => {
  assert.equal(canTransition('pending', 'downloading'), true);
  assert.equal(canTransition('downloading', 'verifying'), true);
  assert.equal(canTransition('running', 'installing'), false);
  assert.equal(canTransition('failed', 'running'), false);
});

test('reports are bounded by event count and marked truncated', () => {
  const report = {
    schema: 'jiezi.diagnostics.v1',
    sessions: [{
      sessionId: 's',
      events: Array.from({ length: 250 }, (_, index) => ({ sequence: index + 1, message: 'x' })),
    }],
  };
  const bounded = boundReport(report);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.droppedEvents, 250 - MAX_EVIDENCE_EVENTS);
  assert.equal(bounded.report.sessions[0].events.length, MAX_EVIDENCE_EVENTS);
  assert.equal(bounded.report.truncated, true);
});

test('long strings are clipped before the byte bound', () => {
  const bounded = boundReport({
    schema: 'jiezi.diagnostics.v1',
    note: 'y'.repeat(70_000),
    sessions: [],
  });
  assert.ok(bounded.report.note.length <= 65_537);
});

test('failure layers map to the expected repair class', () => {
  assert.equal(classifyFailure({ layer: 'host-component' }), 'host-component');
  assert.equal(classifyFailure({ code: 'SIGNATURE_INVALID' }), 'refused');
  assert.equal(classifyFailure({ code: 'COMPILE_ERROR' }), 'compile');
  assert.equal(classifyFailure({ code: 'TIMEOUT' }), 'timeout');
  assert.equal(classifyFailure({ code: 'something-else' }), 'runtime');
});

test('tokens are hashed, not stored', () => {
  const token = 'device-token-value';
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(hashToken(token), hash);
});

test('oxc compiler blocks become file, line, column errors', () => {
  const stderr = [
    'error building hello/App.tsx failed',
    'App.tsx',
    '',
    '  x <Text> names nothing in scope: add `import { Text } from "nsh"`',
    '   ,-[2:11]',
    ' 1 | export default function App() {',
    ' 2 |   return <Text>Hello JieZi</Text>',
    '   :           ^^^^',
  ].join('\n');
  const errors = parseBuildErrors(stderr, 'App.tsx');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'hello/App.tsx');
  assert.equal(errors[0].line, 2);
  assert.equal(errors[0].column, 11);
  assert.match(errors[0].message, /names nothing in scope/);
});

test('tsc diagnostics are parsed too', () => {
  const errors = parseBuildErrors('App.tsx(4,9): error TS2304: Cannot find name x.', 'App.tsx');
  assert.deepEqual(errors, [{
    file: 'App.tsx',
    line: 4,
    column: 9,
    message: 'TS2304: Cannot find name x.',
  }]);
});

test('release identity includes the build number so signed artifacts cannot collide', () => {
  const first = releaseIdFor('0123456789abcdef' + '0'.repeat(48), 7);
  const second = releaseIdFor('0123456789abcdef' + '0'.repeat(48), 8);
  const same = releaseIdFor('0123456789abcdef' + '0'.repeat(48), 7);
  assert.equal(first, 'rel_0123456789abcdef_7');
  assert.equal(first, same);
  assert.notEqual(first, second);
});

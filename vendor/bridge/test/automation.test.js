import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = resolve(fileURLToPath(new URL('.', import.meta.url)), '../src/cli.js');

test('QR pairing sessions, bearer upgrades and automation stay bounded and idempotent', { timeout: 60_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-automation-test-'));
  let child;
  try {
    execFileSync(process.execPath, [CLI, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0'], { encoding: 'utf8' });
    child = spawn(process.execPath, [CLI, 'serve', '--state-dir', stateDir, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const info = await startInfo(child, () => stderr);

    const created = await uds(info.socket, 'POST', '/v1/pairing-sessions', { ttlMs: 30_000 });
    assert.equal(created.pairing.certificateFingerprint, null);
    assert.match(created.pairing.sessionId, /^pair_[0-9a-f]{24}$/);
    assert.match(created.pairing.code, /^[A-Z2-9]{8}$/);

    const pairing = await pairSession(info.deviceUrl, created.pairing);
    const status = await uds(info.socket, 'GET', `/v1/pairing-sessions/${created.pairing.sessionId}`);
    assert.equal(status.pairing.state, 'paired');
    assert.equal(status.pairing.deviceId, pairing.deviceId);

    const reused = await pairSession(info.deviceUrl, created.pairing, true);
    assert.match(reused, /no longer waiting/);

    const upgrade = await bearerUpgrade(info.deviceUrl, pairing.deviceToken);
    assert.equal(upgrade.status, 101);
    upgrade.socket.destroy();

    const device = await connect(`${info.deviceUrl}?token=${encodeURIComponent(pairing.deviceToken)}`);
    await device.next('hello');
    await device.send('ready', {
      deviceName: 'Automation iPhone',
      targetKind: 'simulator',
      appVersion: '1.0',
      developerMode: true,
      automation: true,
      appId: 'com.jiezi.automation.demo',
      releaseId: 'rel_0123456789abcdef',
      instanceId: 'instance-1',
      installedApps: [{ appId: 'com.jiezi.automation.demo', title: 'Demo', releaseId: 'rel_0123456789abcdef', state: 'running', active: true }],
    });
    const listed = await waitForDevice(info.socket, pairing.deviceId);
    assert.equal(listed.online, true);
    assert.equal(listed.developerMode, true);
    assert.equal(listed.automation, true);
    assert.equal(listed.activeApp.appId, 'com.jiezi.automation.demo');
    assert.equal(listed.targetKind, 'simulator');
    assert.equal(listed.hostVersion, '1.0');
    assert.equal(listed.tokenHash, undefined);

    const observe = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'observe-op-1',
      action: 'observe',
    });
    const message = await device.next('automationRequest');
    assert.equal(message.payload.requestId, observe.request.requestId);
    // Presence is only a validation hint; an omitted identity is not echoed
    // back as a stale pre-deploy instance.
    assert.equal(message.payload.appId, null);
    assert.equal(message.payload.instanceId, null);
    await device.send('automationResult', {
      requestId: observe.request.requestId,
      opId: 'observe-op-1',
      state: 'done',
      snapshot: {
        snapshotId: 'snap-1',
        appId: 'com.jiezi.automation.demo',
        releaseId: 'rel_0123456789abcdef',
        instanceId: 'instance-1',
        mode: 'semantic',
        capabilities: ['tap'],
        screen: { width: 402, height: 874 },
        nodes: [{ alias: '@1', testID: 'demo.increment', label: '+1', role: 'button', frame: { x: 1, y: 2, width: 3, height: 4 }, enabled: true, visible: true, path: 'root/0' }],
      },
    });
    const observed = await waitAutomation(info.socket, observe.request.requestId);
    assert.equal(observed.state, 'done');
    assert.equal(observed.snapshot.nodes[0].testID, 'demo.increment');
    assert.deepEqual(observed.snapshot.screen, { width: 402, height: 874 });

    const duplicate = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'observe-op-1',
      action: 'observe',
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.request.requestId, observe.request.requestId);

    const conflict = await udsError(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'observe-op-1',
      action: 'tap',
      target: { testID: 'demo.increment' },
    });
    assert.equal(conflict.error.code, 'op_conflict');

    const stale = await udsError(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'stale-op',
      action: 'tap',
      instanceId: 'instance-old',
      target: { testID: 'demo.increment' },
    });
    assert.equal(stale.error.code, 'stale_instance');

    const tap = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'tap-op-1',
      action: 'tap',
      snapshotId: 'snap-1',
      target: { testID: 'demo.increment' },
      expect: { visibleTestID: 'demo.count', textContains: '1' },
    });
    const tapMessage = await device.next('automationRequest');
    assert.deepEqual(tapMessage.payload.target, { testID: 'demo.increment' });
    assert.deepEqual(tapMessage.payload.expect, { visibleTestID: 'demo.count', textContains: '1' });
    await device.send('automationResult', {
      requestId: tap.request.requestId,
      opId: 'tap-op-1',
      state: 'done',
      snapshot: { ...observed.snapshot, snapshotId: 'snap-2' },
    });
    const tapped = await waitAutomation(info.socket, tap.request.requestId);
    assert.equal(tapped.state, 'done');
    assert.equal(tapped.snapshot.snapshotId, 'snap-2');

    const open = await uds(info.socket, 'POST', '/v1/open', {
      deviceId: pairing.deviceId,
      appId: 'com.jiezi.automation.demo',
    });
    const openMessage = await device.next('openAppRequest');
    assert.equal(openMessage.payload.appId, 'com.jiezi.automation.demo');
    await device.send('openAppResult', {
      requestId: open.request.requestId,
      appId: 'com.jiezi.automation.demo',
      state: 'done',
      instanceId: 'instance-open',
    });
    const opened = await waitOpen(info.socket, open.request.requestId);
    assert.equal(opened.state, 'done');
    assert.equal(opened.instanceId, 'instance-open');

    const type = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'type-op-1',
      action: 'type',
      target: { testID: 'demo.input' },
      text: '自动化输入',
      replace: true,
    });
    const typeMessage = await device.next('automationRequest');
    assert.equal(typeMessage.payload.action, 'type');
    assert.deepEqual(typeMessage.payload.target, { testID: 'demo.input' });
    assert.equal(typeMessage.payload.text, '自动化输入');
    assert.equal(typeMessage.payload.replace, true);
    await device.send('automationResult', {
      requestId: type.request.requestId,
      opId: 'type-op-1',
      state: 'done',
      snapshot: {
        ...observed.snapshot,
        snapshotId: 'snap-3',
        nodes: [{
          alias: '@2', testID: 'demo.input', label: '占位符：名称', role: 'textField',
          value: '自动化输入', focused: true, enabled: true, visible: true,
          frame: { x: 1, y: 40, width: 200, height: 40 }, path: 'root/1',
        }],
      },
    });
    const typed = await waitAutomation(info.socket, type.request.requestId);
    assert.equal(typed.state, 'done');
    assert.equal(typed.snapshot.nodes[0].value, '自动化输入');
    assert.equal(typed.snapshot.nodes[0].focused, true);

    const missingText = await udsError(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'type-op-2',
      action: 'type',
      target: { testID: 'demo.input' },
    });
    assert.equal(missingText.error.code, 'invalid_request');

    const scroll = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'scroll-op-1',
      action: 'scroll',
      target: { testID: 'demo.screen' },
      direction: 'down',
      amount: 0.8,
    });
    const scrollMessage = await device.next('automationRequest');
    assert.equal(scrollMessage.payload.action, 'scroll');
    assert.equal(scrollMessage.payload.direction, 'down');
    assert.equal(scrollMessage.payload.amount, 0.8);
    await device.send('automationResult', {
      requestId: scroll.request.requestId,
      opId: 'scroll-op-1',
      state: 'done',
      snapshot: { ...observed.snapshot, snapshotId: 'snap-4' },
    });
    const scrolled = await waitAutomation(info.socket, scroll.request.requestId);
    assert.equal(scrolled.state, 'done');

    const bounded = await uds(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'bounded-op',
      action: 'observe',
    });
    const boundedMessage = await device.next('automationRequest');
    await device.send('automationResult', {
      requestId: boundedMessage.payload.requestId,
      opId: 'bounded-op',
      state: 'done',
      diagnostics: {
        cursor: 7,
        sequences: [8],
        events: [{
          sequence: 8,
          level: 'error',
          code: 'NSH_UNCAUGHT_ERROR',
          message: 'probe handler failure',
          timestamp: '2026-11-22T03:52:32Z',
        }],
      },
      hostAlert: {
        code: 'RUNTIME_ERROR_ALERT',
        message: '小程序运行错误：probe handler failure',
        appId: 'com.jiezi.automation.demo',
        instanceId: 'instance-1',
      },
      snapshot: {
        ...observed.snapshot,
        snapshotId: 'snap-bounded',
        nodes: Array.from({ length: 350 }, (_, index) => ({
          alias: `@${index}`,
          testID: `node-${index}`,
          label: index === 0 ? 'x'.repeat(600) : `node ${index}`,
          role: 'text',
          frame: { x: 0, y: index, width: 10, height: 10 },
          enabled: true,
          visible: true,
          path: `root/${index}`,
        })),
      },
    });
    const boundedResult = await waitAutomation(info.socket, bounded.request.requestId);
    assert.equal(boundedResult.state, 'done');
    assert.equal(boundedResult.snapshot.nodes.length, 300);
    assert.equal(boundedResult.snapshot.truncated, true);
    assert.equal(boundedResult.snapshot.nodes[0].label.length, 512);
    assert.equal(boundedResult.diagnostics.events[0].code, 'NSH_UNCAUGHT_ERROR');
    assert.equal(boundedResult.diagnostics.events[0].message, 'probe handler failure');
    assert.equal(boundedResult.hostAlert.code, 'RUNTIME_ERROR_ALERT');
    assert.equal(boundedResult.hostAlert.instanceId, 'instance-1');

    // Immutable release IDs: every build gets its own release id and artifact,
    // so deploying A -> B -> A must produce three distinct operations.
    const releases = [
      { releaseId: 'rel_aaaaaaaaaaaaaaaa_1', build: 1, sha256: '1'.repeat(64) },
      { releaseId: 'rel_bbbbbbbbbbbbbbbb_2', build: 2, sha256: '2'.repeat(64) },
      { releaseId: 'rel_aaaaaaaaaaaaaaaa_3', build: 3, sha256: '3'.repeat(64) },
    ];
    for (const release of releases) {
      writeFileSync(
        join(stateDir, 'artifacts', `${release.releaseId}.nshpkg.json`),
        JSON.stringify({
          ...release,
          projectId: 'automation-demo',
          signed: true,
          keyId: 'test-key',
        }),
      );
    }
    const deployed = [];
    for (const release of releases) {
      const result = await uds(info.socket, 'POST', '/v1/deploy', {
        deviceId: pairing.deviceId,
        releaseId: release.releaseId,
      });
      deployed.push(result);
      const deployMessage = await device.next('deploy');
      assert.equal(deployMessage.payload.releaseId, release.releaseId);
    }
    assert.equal(new Set(deployed.map((entry) => entry.opId)).size, 3);

    // The same (release, device) operation is reused unless force is true;
    // force must allocate a new id so the Host runs a real install/launch and
    // can clear a stuck instance or Host alert.
    const deduplicated = await uds(info.socket, 'POST', '/v1/deploy', {
      deviceId: pairing.deviceId,
      releaseId: releases[2].releaseId,
    });
    assert.equal(deduplicated.deduplicated, true);
    assert.equal(deduplicated.reinstalled, false);
    assert.equal(deduplicated.opId, deployed[2].opId);
    assert.match(deduplicated.nextAction, /miniapp_reload/);
    const resentMessage = await device.next('deploy');
    assert.equal(resentMessage.payload.opId, deduplicated.opId);

    const forced = await uds(info.socket, 'POST', '/v1/deploy', {
      deviceId: pairing.deviceId,
      releaseId: releases[2].releaseId,
      force: true,
    });
    assert.equal(forced.deduplicated, false);
    assert.equal(forced.reinstalled, true);
    assert.equal(forced.forced, true);
    assert.notEqual(forced.opId, deployed[2].opId);
    const forcedMessage = await device.next('deploy');
    assert.equal(forcedMessage.payload.opId, forced.opId);
    assert.equal(forcedMessage.payload.releaseId, releases[2].releaseId);

    // Evidence from another release is refused rather than attached to this
    // operation (018 plan §4.5).
    await device.send('evidence', {
      opId: deployed[0].opId,
      releaseId: releases[1].releaseId,
      report: { events: [] },
    });
    const rejectedEvidence = await device.next('error');
    assert.equal(rejectedEvidence.payload.code, 'invalid_request');

    // A canonical diagnostics report stores events at the report top level; the
    // summary names the newest error, not the first one.
    await device.send('evidence', {
      opId: deployed[0].opId,
      releaseId: releases[0].releaseId,
      sessionId: 'session-test',
      report: {
        schema: 'jiezi.diagnostics.v1',
        app: { appID: 'com.jiezi.automation.demo' },
        sessions: [{ id: 'session-test', events: [] }],
        events: [
          { sequence: 1, level: 'info', message: 'started' },
          { sequence: 2, level: 'error', message: 'boom', code: 'E_BOOM' },
          { sequence: 3, level: 'error', message: 'latest boom', code: 'E_LATEST' },
        ],
        snapshots: [],
      },
    });
    const evidenceId = await waitForEvidenceId(info.socket, deployed[0].opId);
    const evidence = await uds(info.socket, 'GET', `/v1/evidence/${evidenceId}`);
    assert.equal(evidence.counts.events, 3);
    assert.equal(evidence.counts.snapshots, 0);
    assert.equal(evidence.summary.message, 'latest boom');
    assert.equal(evidence.summary.code, 'E_LATEST');

    // The P0 capture handshake remains bounded and can be read by request id.
    const captureStart = await uds(info.socket, 'POST', '/v1/capture', { deviceId: pairing.deviceId });
    const captureMessage = await device.next('capture');
    await device.send('captureResult', {
      requestId: captureMessage.payload.requestId,
      tree: { role: 'root' },
      note: 'test',
    });
    const capture = await uds(info.socket, 'GET', `/v1/captures/${captureStart.requestId}`);
    assert.equal(capture.capture.state, 'done');
    assert.deepEqual(capture.capture.result.tree, { role: 'root' });
    assert.equal(capture.capture.result.note, 'test');

    // Explicit automation stop is durable; an ordinary disconnect alone is not
    // interpreted as consent revocation. Close code 4007 marks full exit.
    await device.send('ready', {
      deviceName: 'Automation iPhone', targetKind: 'simulator', appVersion: '1.0',
      developerMode: true, automation: false, appId: null, releaseId: null,
      instanceId: null, installedApps: [],
    });
    let stopped;
    for (let i = 0; i < 40; i += 1) {
      const listed = await uds(info.socket, 'GET', '/v1/devices');
      stopped = listed.devices.find((entry) => entry.deviceId === pairing.deviceId);
      if (stopped?.revocation?.automation) break;
      await delay(25);
    }
    assert.equal(stopped?.revocation?.automation, true);
    device.close(4007);
    await waitForOffline(info.socket, pairing.deviceId);
    const revokedOffline = await uds(info.socket, 'GET', '/v1/devices');
    const revokedRecord = revokedOffline.devices.find((entry) => entry.deviceId === pairing.deviceId);
    assert.equal(revokedRecord.revocation.automation, true);
    assert.equal(revokedRecord.revocation.developerMode, true);

    // Explicit reactivation replaces the durable revocation with a fresh grant.
    const reactivated = await connect(`${info.deviceUrl}?token=${encodeURIComponent(pairing.deviceToken)}`);
    await reactivated.next('hello');
    await reactivated.send('ready', {
      deviceName: 'Automation iPhone', targetKind: 'simulator', appVersion: '1.0',
      developerMode: true, automation: true, appId: null, releaseId: null,
      instanceId: null, installedApps: [],
    });
    await waitForDevice(info.socket, pairing.deviceId);
    const cleared = await uds(info.socket, 'GET', '/v1/devices');
    assert.equal(cleared.devices.find((entry) => entry.deviceId === pairing.deviceId).revocation, undefined);
    reactivated.close();
    await waitForOffline(info.socket, pairing.deviceId);
    const offline = await udsError(info.socket, 'POST', '/v1/automation', {
      deviceId: pairing.deviceId,
      opId: 'offline-op',
      action: 'observe',
    });
    assert.equal(offline.error.code, 'device_offline');

    // Unpair removes the device record; a later deploy must report not_paired.
    const unpaired = await uds(info.socket, 'POST', '/v1/unpair', { deviceId: pairing.deviceId });
    assert.equal(unpaired.ok, true);
    const afterUnpair = await uds(info.socket, 'GET', '/v1/devices');
    assert.equal(afterUnpair.devices.some((entry) => entry.deviceId === pairing.deviceId), false);
    const missing = await udsError(info.socket, 'POST', '/v1/deploy', {
      deviceId: pairing.deviceId,
      releaseId: releases[0].releaseId,
    });
    assert.equal(missing.error.code, 'not_paired');
  } finally {
    child?.kill('SIGTERM');
    if (child) await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 3000);
      child.on('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function startInfo(child, stderr) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`bridge timeout: ${stderr()}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const value = JSON.parse(line);
          if (value.ok) {
            clearTimeout(timer);
            resolvePromise(value);
          }
        } catch {
          // Wait for a complete line.
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited ${code}: ${stderr()}`));
    });
  });
}

function pairSession(deviceUrl, pairing, expectFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(deviceUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('pairing timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        v: 1,
        id: 'pair-session-test',
        type: 'pair',
        ts: new Date().toISOString(),
        payload: {
          sessionId: pairing.sessionId,
          code: pairing.code,
          deviceName: 'Automation iPhone',
          targetKind: 'simulator',
          publicKey: Buffer.from('automation-key').toString('base64'),
        },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'paired') {
        clearTimeout(timer);
        socket.close();
        if (expectFailure) reject(new Error('pairing unexpectedly succeeded'));
        else resolvePromise(message.payload);
      }
      if (message.type === 'pairError') {
        clearTimeout(timer);
        socket.close();
        if (expectFailure) resolvePromise(message.payload.message);
        else reject(new Error(message.payload.message));
      }
    });
    socket.addEventListener('error', () => reject(new Error('websocket failed')));
  });
}

function bearerUpgrade(deviceUrl, token) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(deviceUrl);
    const key = randomBytes(16).toString('base64');
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        Authorization: `Bearer ${token}`,
      },
    });
    req.on('upgrade', (response, socket) => {
      resolvePromise({ status: response.statusCode, socket });
    });
    req.on('response', (response) => {
      response.resume();
      reject(new Error(`upgrade refused with ${response.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url);
    const queue = [];
    const waiters = [];
    let opened = false;
    socket.addEventListener('open', () => { opened = true; resolvePromise(api); });
    socket.addEventListener('error', () => reject(new Error(`websocket error: ${url}`)));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const index = waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        queue.push(message);
      }
    });
    const api = {
      send(type, payload) {
        if (!opened) throw new Error('websocket is not open');
        socket.send(JSON.stringify({ v: 1, id: `test_${Date.now()}`, type, ts: new Date().toISOString(), payload }));
        return Promise.resolve();
      },
      next(type, timeoutMs = 10_000) {
        const found = queue.findIndex((message) => message.type === type);
        if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);
        return new Promise((resolveNext, rejectNext) => {
          const waiter = {
            type,
            resolve: resolveNext,
            timer: setTimeout(() => rejectNext(new Error(`timed out waiting for ${type}`)), timeoutMs),
          };
          waiters.push(waiter);
        });
      },
      close(code) { socket.close(code); },
    };
  });
}

async function waitForEvidenceId(socketPath, opId) {
  for (let i = 0; i < 40; i += 1) {
    const result = await uds(socketPath, 'GET', `/v1/ops/${encodeURIComponent(opId)}`);
    if (typeof result.op?.evidenceId === 'string') return result.op.evidenceId;
    await delay(50);
  }
  throw new Error('evidence did not arrive');
}

async function waitForDevice(socketPath, deviceId) {
  for (let i = 0; i < 40; i += 1) {
    const devices = await uds(socketPath, 'GET', '/v1/devices');
    const device = devices.devices.find((item) => item.deviceId === deviceId);
    if (device?.online && device.automation) return device;
    await delay(50);
  }
  throw new Error('device presence did not arrive');
}

async function waitForOffline(socketPath, deviceId) {
  for (let i = 0; i < 40; i += 1) {
    const devices = await uds(socketPath, 'GET', '/v1/devices');
    const device = devices.devices.find((item) => item.deviceId === deviceId);
    if (device && !device.online) return;
    await delay(50);
  }
  throw new Error('device did not go offline');
}

async function waitOpen(socketPath, requestId) {
  for (let i = 0; i < 40; i += 1) {
    const result = await uds(socketPath, 'GET', `/v1/open/${requestId}`);
    if (result.request.state !== 'pending') return result.request;
    await delay(50);
  }
  throw new Error('open did not settle');
}

async function waitAutomation(socketPath, requestId) {
  for (let i = 0; i < 40; i += 1) {
    const result = await uds(socketPath, 'GET', `/v1/automation/${requestId}`);
    if (result.request.state !== 'pending') return result.request;
    await delay(50);
  }
  throw new Error('automation did not settle');
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function uds(socketPath, method, path, body) {
  return udsRaw(socketPath, method, path, body).then(({ status, value }) => {
    if (status >= 400) throw new Error(`${value.error?.code ?? status}: ${value.error?.message ?? ''}`);
    return value;
  });
}

function udsError(socketPath, method, path, body) {
  return udsRaw(socketPath, method, path, body).then(({ value }) => value);
}

function udsRaw(socketPath, method, path, body) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({
      socketPath,
      path,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolvePromise({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bridge, assertReleaseMatchesRecord } from '../src/bridge.js';
import { configFor } from '../src/cli.js';
import { installIdentity } from '../src/identity.js';
import { pack } from './jz-fixtures.js';
import { Store, writeJsonAtomic } from '../src/store.js';

const CLI = resolve(fileURLToPath(new URL('.', import.meta.url)), '../src/cli.js');

test('bridge pairs a device, protects its socket, and reports health', { timeout: 60_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-bridge-test-'));
  try {
    execFileSync(process.execPath, [
      CLI, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0',
    ], { encoding: 'utf8' });

    const child = spawn(process.execPath, [CLI, 'serve', '--state-dir', stateDir, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const info = await new Promise((resolvePromise, reject) => {
      let stdout = '';
      const timer = setTimeout(() => reject(new Error(`bridge start timeout: ${stderr}`)), 15_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        const line = stdout.split('\n').find((value) => value.trim().startsWith('{'));
        if (!line) return;
        try {
          const value = JSON.parse(line);
          if (value.ok) {
            clearTimeout(timer);
            resolvePromise(value);
          }
        } catch {
          // Wait for the complete JSON line.
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`bridge exited ${code}: ${stderr}`));
      });
    });

    try {
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(info.socket).mode & 0o777, 0o600);
      const health = await uds(info.socket, 'GET', '/v1/health');
      assert.equal(health.ok, true);
      assert.equal(health.socket, info.socket);
      assert.equal(health.install.packageRoot, installIdentity().packageRoot);
      assert.equal(health.install.packageHash, installIdentity().packageHash);
      assert.equal(health.install.version, installIdentity().version);
      assert.equal(typeof health.startedAt, 'string');
      assert.equal(health.nsh, process.env.NSH_TOOLCHAIN ?? health.nsh);

      const pairing = JSON.parse(execFileSync(process.execPath, [
        CLI, 'pair-code', '--state-dir', stateDir,
      ], { encoding: 'utf8' }));
      const paired = await pairDevice(info.deviceUrl, pairing.code);
      assert.match(paired.deviceId, /^dev_[0-9a-f]{16}$/);
      assert.ok(paired.deviceToken.length >= 32);

      const devices = await uds(info.socket, 'GET', '/v1/devices');
      assert.equal(devices.devices.length, 1);
      assert.equal(devices.devices[0].tokenHash, undefined);

      // The same device key re-pairs to the same device record; a QR code is
      // not a new device identity.
      const secondCode = JSON.parse(execFileSync(process.execPath, [
        CLI, 'pair-code', '--state-dir', stateDir,
      ], { encoding: 'utf8' })).code;
      const repaired = await pairDevice(info.deviceUrl, secondCode);
      assert.equal(repaired.deviceId, paired.deviceId);
      const afterRepair = await uds(info.socket, 'GET', '/v1/devices');
      assert.equal(afterRepair.devices.length, 1);
      assert.equal(afterRepair.devices[0].deviceId, paired.deviceId);

      // A `.jz` is downloadable only while a release record names it: a stray
      // file in the shared artifact directory is not handed to a device.
      const artifacts = join(stateDir, 'artifacts');
      const releaseId = 'rel_cccccccccccccccc_1';
      writeFileSync(join(artifacts, `${releaseId}.jz`), Buffer.from('stray bytes'));
      const ungated = await deviceHttp(info.deviceUrl, `/packages/${releaseId}`, repaired.deviceToken);
      assert.equal(ungated.status, 404);
      writeFileSync(join(artifacts, `${releaseId}.nshpkg.json`), JSON.stringify({
        releaseId,
        signed: true,
        packagePath: join(artifacts, `${releaseId}.jz`),
      }));
      const gated = await deviceHttp(info.deviceUrl, `/packages/${releaseId}`, repaired.deviceToken);
      assert.equal(gated.status, 200);
      assert.equal(gated.headers['content-type'], 'application/vnd.jiezi.miniapp+zip');
      assert.equal(gated.body.toString('utf8'), 'stray bytes');
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 3000);
        child.on('exit', () => { clearTimeout(timer); resolvePromise(); });
      });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function pairDevice(deviceUrl, code) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(deviceUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('pairing timed out'));
    }, 10_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        v: 1,
        id: 'pair-test',
        type: 'pair',
        ts: new Date().toISOString(),
        payload: {
          code,
          deviceName: 'Test iPhone',
          publicKey: Buffer.from('test-key').toString('base64'),
        },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'paired') {
        clearTimeout(timer);
        socket.close();
        resolvePromise(message.payload);
      }
      if (message.type === 'pairError') {
        clearTimeout(timer);
        socket.close();
        reject(new Error(message.payload.message));
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket failed'));
    });
  });
}

function uds(socketPath, method, path, body) {
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
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
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


test('deploy re-verification binds the whole release record, not only the digest', () => {
  const verified = {
    manifest: { app: { id: 'com.jiezi.miniapp.demo', name: 'Demo', version: '1.0.0', build: 3 } },
    packageSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    payloadSha256: 'c'.repeat(64),
  };
  const record = {
    appId: 'com.jiezi.miniapp.demo',
    name: 'Demo',
    version: '1.0.0',
    build: 3,
    packageSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    payloadSha256: 'c'.repeat(64),
  };
  assert.doesNotThrow(() => assertReleaseMatchesRecord(record, verified));
  for (const [field, value] of [
    ['appId', 'com.jiezi.miniapp.other'],
    ['name', 'Evil'],
    ['version', '9.9.9'],
    ['build', 4],
    ['packageSha256', 'd'.repeat(64)],
    ['manifestSha256', 'd'.repeat(64)],
    ['payloadSha256', 'd'.repeat(64)],
  ]) {
    assert.throws(
      () => assertReleaseMatchesRecord({ ...record, [field]: value }, verified),
      (error) => {
        assert.equal(error.code, 'refused');
        assert.match(error.message, new RegExp(field));
        return true;
      },
      field,
    );
  }
  // A record that predates a field cannot vouch for the artifact either.
  const { payloadSha256, ...legacy } = record;
  assert.throws(() => assertReleaseMatchesRecord(legacy, verified), { code: 'refused' });
});

test('only a release record that names a .jz makes it downloadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'jiezi-package-path-'));
  try {
    const store = new Store(root);
    const bridge = new Bridge({ store, config: {} });
    const releaseId = 'rel_aaaaaaaaaaaaaaaa_1';
    writeFileSync(join(store.paths.artifacts, `${releaseId}.jz`), Buffer.from('fake'));
    // A stray file without a release record is not served.
    assert.equal(bridge.packagePath(releaseId), null);

    // A record that does not name the package is not served either.
    const metaPath = join(store.paths.artifacts, `${releaseId}.nshpkg.json`);
    writeJsonAtomic(metaPath, { releaseId, signed: true });
    assert.equal(bridge.packagePath(releaseId), null);

    writeJsonAtomic(metaPath, {
      releaseId,
      signed: true,
      packagePath: join(store.paths.artifacts, `${releaseId}.jz`),
    });
    assert.equal(bridge.packagePath(releaseId), join(store.paths.artifacts, `${releaseId}.jz`));

    // A record that names some other path cannot make the stray file served.
    writeJsonAtomic(metaPath, { releaseId, signed: true, packagePath: join(root, 'elsewhere.jz') });
    assert.equal(bridge.packagePath(releaseId), null);
    writeJsonAtomic(metaPath, {
      releaseId,
      signed: true,
      packagePath: join(store.paths.artifacts, `${releaseId}.jz`),
    });

    rmSync(join(store.paths.artifacts, `${releaseId}.jz`));
    assert.equal(bridge.packagePath(releaseId), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI wires production trust roots and the revocation list into config', () => {
  const root = mkdtempSync(join(tmpdir(), 'jiezi-trust-config-'));
  try {
    const store = new Store(root);
    const rootA = join(root, 'root-a.pub');
    const rootB = join(root, 'root-b.pub');
    const revocations = join(root, 'revocations.json');
    const config = configFor({
      nsh: process.execPath,
      'trust-root': `${rootA}${delimiter}${rootB}`,
      revocations,
    }, store);
    assert.deepEqual(config.trustRootPaths, [resolve(rootA), resolve(rootB)]);
    assert.equal(config.revocationsPath, resolve(revocations));
    assert.notEqual(config.nshPath, undefined);
    assert.notEqual(config.nshPath.length, 0);

    // A config without the flags keeps the configured trust data, and an
    // explicit empty list clears it.
    store.saveConfig(config);
    const kept = configFor({ nsh: process.execPath }, store);
    assert.deepEqual(kept.trustRootPaths, [resolve(rootA), resolve(rootB)]);
    assert.equal(kept.revocationsPath, resolve(revocations));
    const cleared = configFor({ nsh: process.execPath, 'trust-root': '', revocations: '' }, store);
    assert.deepEqual(cleared.trustRootPaths, []);
    assert.equal(cleared.revocationsPath, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic replaces a record without leaving temp files', () => {
  const root = mkdtempSync(join(tmpdir(), 'jiezi-atomic-'));
  try {
    const path = join(root, 'record.json');
    writeJsonAtomic(path, { build: 1 });
    writeJsonAtomic(path, { build: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { build: 2 });
    assert.deepEqual(readdirSync(root), ['record.json']);
    // A failing serialization must not leave the half-written temp file
    // behind: the next reader would otherwise see stale/partial state.
    const circular = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(join(root, 'broken.json'), circular));
    assert.deepEqual(readdirSync(root), ['record.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


function deviceHttp(deviceUrl, path, token) {
  const url = new URL(deviceUrl);
  return new Promise((resolvePromise, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('deploy re-verifies the recorded .jz and refuses a swapped release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jiezi-deploy-verify-'));
  try {
    const store = new Store(root);
    const fixture = pack();
    const releaseId = 'rel_aaaaaaaaaaaaaaaa_1';
    const packagePath = join(store.paths.artifacts, `${releaseId}.jz`);
    writeFileSync(packagePath, readFileSync(fixture.result.packagePath));
    const rootPubPath = join(root, 'root.pub');
    writeFileSync(rootPubPath, fixture.key.root.pub.toString('base64'));
    const recordPath = join(store.paths.artifacts, `${releaseId}.nshpkg.json`);
    const record = {
      releaseId,
      projectId: 'demo',
      build: fixture.result.build,
      signed: true,
      appId: fixture.result.appId,
      name: fixture.result.name,
      version: fixture.result.version,
      packagePath,
      packageSha256: fixture.result.packageSha256,
      payloadSha256: fixture.result.payloadSha256,
      manifestSha256: fixture.result.manifestSha256,
      minRuntime: fixture.result.minRuntime,
    };
    writeJsonAtomic(recordPath, record);

    const deviceId = 'dev_0123456789abcdef';
    store.saveDevice({ deviceId, tokenHash: 'hash', publicKey: 'key', pairedAt: new Date().toISOString() });
    const bridge = new Bridge({
      store,
      config: { trustRootPaths: [rootPubPath], host: '127.0.0.1', port: 0 },
    });
    bridge.deviceAddress = { port: 1 };
    bridge.devices.set(deviceId, { connection: { send: () => true }, presence: null });

    const deployed = await bridge.deploy({ deviceId, releaseId });
    assert.equal(deployed.reinstalled, true);

    // The record's promise must still match the file: a changed identity, or
    // changed bytes, is refused before anything reaches the device.
    writeJsonAtomic(recordPath, { ...record, name: 'Evil' });
    await assert.rejects(bridge.deploy({ deviceId, releaseId }), { code: 'refused' });
    writeJsonAtomic(recordPath, record);
    writeFileSync(packagePath, Buffer.concat([readFileSync(packagePath), Buffer.from([0])]));
    await assert.rejects(bridge.deploy({ deviceId, releaseId }), { code: 'JZ_BAD_ARCHIVE' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

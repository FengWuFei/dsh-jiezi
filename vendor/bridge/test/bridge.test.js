import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/tools.js';
import { getSharedOperations } from '../lib/host/operations.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CLI = join(ROOT, 'vendor/bridge/src/cli.js');
const NSH = process.env.NSH_TOOLCHAIN ?? join(process.env.HOME ?? '', 'Desktop/native-shell-demo/.tooling/nsh/bin/nsh');

test('preset tools execute against a live jiezi-bridge', { timeout: 120_000 }, async (context) => {
  if (!existsSync(NSH)) {
    context.skip(`pinned nsh toolchain not found at ${NSH}`);
    return;
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-dsh-live-'));
  execFileSync(process.execPath, [CLI, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0'], {
    encoding: 'utf8',
  });
  const child = spawn(process.execPath, [CLI, 'serve', '--state-dir', stateDir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const info = await new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${stderr}`)), 20_000);
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
        // Wait for a complete JSON line.
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited ${code}: ${stderr}`));
    });
  });

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

  try {
    apply(ctx, { socketPath: info.socket, timeoutMs: 60_000 });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'miniapp_action', 'miniapp_build', 'miniapp_capture', 'miniapp_deploy',
      'miniapp_device', 'miniapp_devices', 'miniapp_diagnostics', 'miniapp_doctor',
      'miniapp_init', 'miniapp_open', 'miniapp_reload', 'miniapp_screen',
      'miniapp_status', 'miniapp_ui',
    ]);
    assert.equal(sections.length, 1);
    assert.match(sections[0].text, /host-component/);

    const devices = tools.find((tool) => tool.name === 'miniapp_devices');
    const deviceList = await devices.execute({}, {});
    assert.equal(deviceList.ok, true);
    assert.deepEqual(deviceList.devices, []);

    // The real bridge answers a pairing session with the exact six-field payload.
    const operations = getSharedOperations({ socketPath: info.socket, timeoutMs: 60_000 });
    const created = await operations.createPairing({ ttlMs: 120_000 });
    assert.equal(created.ok, true);
    assert.deepEqual(Object.keys(created.pairing.payload).sort(), [
      'certificateFingerprint', 'code', 'endpoint', 'expiresAt', 'schema', 'sessionId',
    ]);
    assert.equal(created.pairing.payload.schema, 'jiezi.pairing.v1');
    assert.match(created.pairing.payload.endpoint, /^wss?:\/\/.+\/device$/);
    assert.match(created.pairing.payload.code, /^[A-Z2-9]{8}$/);
    assert.equal(created.pairing.state, 'waiting');
    const sessionId = created.pairing.payload.sessionId;
    const waiting = await operations.pairingStatus({ sessionId });
    assert.equal(waiting.pairing.state, 'waiting');
    assert.equal(waiting.pairing.payload.sessionId, sessionId);

    const init = tools.find((tool) => tool.name === 'miniapp_init');
    const initialized = await init.execute({ projectId: 'hello', name: 'Hello JieZi', appId: 'com.jiezi.hello' }, {});
    assert.equal(initialized.ok, true);
    assert.equal(initialized.projectId, 'hello');
    assert.equal(initialized.projectDir, realpathSync(join(stateDir, 'projects', 'hello')));
    assert.equal(initialized.template, 'jiezi-basic@1');
    assert.equal(initialized.adapter, 'jiezi/native@0.2.0');
    assert.equal(existsSync(join(initialized.projectDir, 'node_modules', 'jiezi', 'native', 'runtime.js')), true);
    const repeated = await init.execute({ projectId: 'hello' }, {});
    assert.equal(repeated.ok, false);
    assert.equal(repeated.code, 'project_exists');

    const build = tools.find((tool) => tool.name === 'miniapp_build');
    const result = await build.execute({ projectId: 'hello' }, {});
    assert.equal(result.ok, true);
    assert.match(result.releaseId, /^rel_[0-9a-f]{16}_\d+$/);
    assert.equal(result.build, 1);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const rebuilt = await build.execute({ projectId: 'hello' }, {});
    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.build, 2);
    assert.notEqual(rebuilt.releaseId, result.releaseId);
    assert.notEqual(rebuilt.artifactPath, result.artifactPath);

    const brokenDir = join(stateDir, 'projects', 'broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'App.tsx'), 'export default function App() { return <Text>Broken</Text>; }\n');
    writeFileSync(join(brokenDir, 'nsh.json'), JSON.stringify({
      name: 'Broken', id: 'com.jiezi.broken', version: '1.0.0', build: 1,
    }));
    const broken = await build.execute({ projectId: 'broken' }, {});
    assert.equal(broken.ok, false);
    assert.equal(broken.stage, 'compile');
    assert.equal(broken.errors[0].file, 'App.tsx');
    assert.ok(broken.errors[0].line > 0);
    assert.ok(broken.errors[0].column > 0);

    const status = tools.find((tool) => tool.name === 'miniapp_status');
    const listed = await status.execute({}, {});
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.ops, []);

    const automation = await tools.find((tool) => tool.name === 'miniapp_ui').execute({ deviceId: 'dev_missing' }, {});
    assert.equal(automation.ok, false);
    assert.equal(automation.code, 'not_paired');
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup?.();
      } catch {
        // Ignore teardown errors.
      }
    }
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 3_000);
      child.on('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installIdentity } from '../src/identity.js';

const CLI = resolve(fileURLToPath(new URL('.', import.meta.url)), '../src/cli.js');
const NSH = process.env.NSH_TOOLCHAIN ?? '';
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('bridge identity is stable across two reads and names the package root', () => {
  const first = installIdentity();
  const second = installIdentity();
  assert.equal(first, second);
  assert.equal(first.version, MANIFEST.version);
  assert.match(first.packageHash, /^[0-9a-f]{24}$/);
  assert.match(first.packageRoot, /(?:companion|vendor)\/bridge$/);
  assert.ok(first.newestMtimeMs > 0);
});

test('doctor --fix rewrites only a stale nsh path and is idempotent', { timeout: 30_000, skip: existsSync(NSH) ? false : 'NSH_TOOLCHAIN is not set' }, () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-doctor-fix-'));
  try {
    const env = { ...process.env, NSH_TOOLCHAIN: NSH };
    execFileSync(process.execPath, [CLI, 'init', '--state-dir', stateDir, '--dev-key', '--port', '0'], { encoding: 'utf8', env });
    const configPath = join(stateDir, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.nshPath = join(stateDir, 'missing-nsh');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const first = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--state-dir', stateDir, '--fix'], { encoding: 'utf8', env }));
    assert.equal(first.fixed, true);
    assert.equal(first.nsh.path, NSH);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).nshPath, NSH);
    assert.ok(first.fixes.some((entry) => entry.includes('nshPath')));
    assert.equal(first.socket.running, false, 'doctor never starts the bridge');
    assert.equal(existsSync(join(stateDir, 'dev-keys', 'root.secret')), true, 'fix does not create or remove keys');

    const second = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--state-dir', stateDir, '--fix'], { encoding: 'utf8', env }));
    assert.equal(second.fixed, false);
    assert.deepEqual(second.fixes, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

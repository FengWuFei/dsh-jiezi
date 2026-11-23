import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundledBridgeVersion, defaultBridgeCliPath } from '../lib/host/bridge-client.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

test('the built bundle ships a bridge it can resolve without the repository', { timeout: 60_000 }, () => {
  const cli = join(ROOT, 'lib', 'bridge', 'cli.js');
  assert.equal(existsSync(cli), true, 'lib/bridge/cli.js is built');
  assert.equal(defaultBridgeCliPath(), cli);

  const bridgePackage = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bridge', 'package.json'), 'utf8'));
  assert.equal(bundledBridgeVersion(), bridgePackage.version);
  for (const path of ['templates/basic/App.tsx', 'templates/basic/App.test.tsx', 'templates/basic/gitignore.template', 'templates/basic/README.md', 'templates/adapter/index.d.ts', 'templates/adapter/runtime.js']) {
    assert.equal(existsSync(join(ROOT, 'lib', 'bridge', path)), true, `built bridge includes ${path}`);
  }

  const stateDir = mkdtempSync(join(tmpdir(), 'jiezi-packaged-'));
  try {
    const output = execFileSync(process.execPath, [cli, 'doctor', '--state-dir', stateDir], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const report = JSON.parse(output);
    assert.equal(report.ok, true);
    assert.equal(report.version, bridgePackage.version);
    assert.equal(report.cli.path, cli);
    assert.equal(report.state.initialized, false);
    assert.equal(report.socket.running, false);
    assert.ok(Array.isArray(report.nsh.candidates));

    // An installed package or a macOS /tmp path may be reached through a
    // symlink; the CLI main guard must compare real paths.
    const link = join(stateDir, 'bridge-cli-link.js');
    symlinkSync(cli, link);
    const linked = JSON.parse(execFileSync(process.execPath, [link, 'doctor', '--state-dir', stateDir], {
      encoding: 'utf8',
      timeout: 30_000,
    }));
    assert.equal(linked.ok, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the package publishes the JieZi mini-app development skill', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('skills'), 'skills is in the package allowlist');

  const skill = readFileSync(join(ROOT, 'skills', 'jiezi-miniapp', 'SKILL.md'), 'utf8');
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'SKILL.md starts with frontmatter');
  assert.match(frontmatter[1], /^name: jiezi-miniapp$/m);
  assert.match(frontmatter[1], /^description: .+mini-app.+/m);
  assert.ok(skill.length < 8192, 'main skill stays below the preset tool-result pruning threshold');
  for (const contract of ['nsh.json', '.nsh/types', 'testID', 'miniapp_build', 'miniapp_deploy', 'miniapp_reload', 'miniapp_status', 'miniapp_ui', 'miniapp_action', 'miniapp_diagnostics', 'miniapp_doctor']) {
    assert.ok(skill.includes(contract), `skill covers ${contract}`);
  }

  for (const name of ['components.md', 'source-and-capabilities.md', 'device-verification-and-repair.md']) {
    const reference = readFileSync(join(ROOT, 'skills', 'jiezi-miniapp', 'references', name), 'utf8');
    assert.ok(reference.length < 8192, `${name} stays below the pruning threshold`);
    assert.ok(skill.includes(`references/${name}`), `skill links ${name}`);
  }
  assert.ok(skill.includes('api/README.md'), 'main skill links the bundled API snapshot');

  const api = join(ROOT, 'skills', 'jiezi-miniapp', 'api');
  for (const path of ['nsh/index.d.ts', 'nsh/types.d.ts', 'nsh/base.d.ts', 'nsh/mobile.d.ts', 'jiezi/native/index.d.ts', 'jiezi/native/index.js', 'jiezi/native/runtime.js']) {
    assert.equal(existsSync(join(api, path)), true, `bundled API includes ${path}`);
  }
  const nshCore = readFileSync(join(api, 'nsh', 'index.d.ts'), 'utf8');
  assert.match(nshCore, /export declare function View/);
  assert.match(nshCore, /export declare function List/);
  const adapter = JSON.parse(readFileSync(join(api, 'jiezi', 'native', 'package.json'), 'utf8'));
  assert.equal(adapter.version, '0.2.0');
  assert.deepEqual(adapter.jiezi.hostComponents, ['jiezi.table@2', 'jiezi.collection@1']);

  // The vendored init adapter is the source of truth for the bundled Host contract.
  const sourceAdapter = resolve(ROOT, 'vendor', 'bridge', 'templates', 'adapter');
  for (const name of ['index.d.ts', 'index.js', 'runtime.js', 'package.json']) {
    const expected = readFileSync(join(sourceAdapter, name), 'utf8');
    assert.equal(readFileSync(join(api, 'jiezi', 'native', name), 'utf8'), expected, `skill adapter ${name} is synchronized`);
  }
});

test('the built initializer resolves packaged templates and adapter', async () => {
  const { initializeProject } = await import('../lib/bridge/project-init.js');
  const projectRoot = mkdtempSync(join(tmpdir(), 'jiezi-built-init-'));
  try {
    const result = await initializeProject({
      body: { projectId: 'packed-check' },
      projectRoot,
      nshPath: '/pinned/nsh',
      runCommand(command, args) {
        const dir = args.at(-1);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'App.tsx'), '// scaffold\n');
        writeFileSync(join(dir, 'App.test.tsx'), '// scaffold test\n');
        writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
        writeFileSync(join(dir, 'nsh.json'), '{"name":"staging","id":"com.example.staging"}\n');
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.template, 'jiezi-basic@1');
    assert.equal(existsSync(join(result.projectDir, '.gitignore')), true);
    assert.equal(existsSync(join(result.projectDir, 'node_modules', 'jiezi', 'native', 'runtime.js')), true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASIC_TEMPLATE, certificateCovers, initializeProject, projectInitRequest } from '../src/project-init.js';
import { initDestination, resolveCallRoot, resolveProjectLayout } from '../src/bridge.js';
import { JZ_SENSITIVE_CAPABILITIES } from '../src/jz.js';
import { validatePurposes, validateSummary } from '../src/jz-manifest.js';
import { validateDescription } from '../src/jz-media.js';

function scaffold(command, args, calls = []) {
  calls.push({ command, args });
  const dir = args.at(-1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'App.tsx'), '// official scaffold, replaced by JieZi\n');
  writeFileSync(join(dir, 'App.test.tsx'), '// official scaffold test\n');
  writeFileSync(join(dir, 'tsconfig.json'), '{"extends":"./.nsh/tsconfig.json"}\n');
  writeFileSync(join(dir, 'nsh.json'), '{"name":"staging","id":"com.example.staging","version":"0.0.1","build":0}\n');
  return Promise.resolve({ code: 0, stdout: 'created', stderr: '' });
}

function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'jiezi-project-init-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

function options(projectRoot, body, runCommand) {
  return { projectRoot, body, nshPath: '/pinned/nsh', runCommand };
}

test('initializes the fixed TSX scaffold, JieZi template, metadata and adapter', async (t) => {
  const projectRoot = fixture(t);
  const calls = [];
  const result = await initializeProject(options(projectRoot, {
    projectId: 'todo-list', name: 'Todo List', appId: 'com.example.todo',
  }, async (command, args, initOptions) => {
    assert.deepEqual(initOptions, { timeoutMs: 60_000 });
    return scaffold(command, args, calls);
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/pinned/nsh');
  assert.equal(calls[0].args.slice(0, 5).join(' '), 'init --template ts --name Todo List');
  assert.match(calls[0].args[5], /\.todo-list\.init-/);
  assert.equal(result.ok, true);
  assert.equal(result.projectId, 'todo-list');
  assert.equal(result.projectDir, realpathSync(join(projectRoot, 'todo-list')));
  assert.equal(result.template, BASIC_TEMPLATE);
  assert.equal(result.adapter, 'jiezi/native@0.2.0');

  const dir = result.projectDir;
  const metadata = JSON.parse(readFileSync(join(dir, 'nsh.json'), 'utf8'));
  assert.deepEqual(metadata, { name: 'Todo List', id: 'com.example.todo', version: '1.0.0', build: 1 });
  assert.match(readFileSync(join(dir, 'App.tsx'), 'utf8'), /testID="counter-increment"/);
  assert.match(readFileSync(join(dir, 'App.test.tsx'), 'utf8'), /press\("Increment"\)/);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /# Todo List/);
  assert.equal(existsSync(join(dir, 'node_modules', 'jiezi', 'native', 'runtime.js')), true);
  // `.jz` needs presentation metadata in the source project.
  const presentation = JSON.parse(readFileSync(join(dir, 'jiezi.json'), 'utf8'));
  assert.equal(presentation.schemaVersion, 1);
  assert.equal(presentation.summary, 'Todo List mini app.');
  assert.match(readFileSync(join(dir, 'docs', 'about.md'), 'utf8'), /# Todo List/);
  assert.ok(result.files.includes('jiezi.json'));
  assert.equal(readdirSync(projectRoot).some((name) => name.includes('.init-')), false);
});

test('accepts an existing empty real directory and derives safe defaults', async (t) => {
  const projectRoot = fixture(t);
  mkdirSync(join(projectRoot, 'empty-app'));
  const result = await initializeProject(options(projectRoot, { projectId: 'empty-app' }, (command, args) => scaffold(command, args, [])));
  assert.equal(result.name, 'Empty App');
  assert.equal(result.appId, 'com.jiezi.miniapp.emptyapp');
  assert.equal(existsSync(join(result.projectDir, 'App.tsx')), true);
});

test('rejects invalid identifiers before invoking the CLI', async (t) => {
  const projectRoot = fixture(t);
  let called = false;
  const runCommand = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  for (const body of [
    { projectId: '../outside' }, { projectId: 'Uppercase' }, { projectId: 'bad-' }, { projectId: 'bad--slug' },
    { projectId: 'valid', name: 'bad\nname' }, { projectId: 'valid', name: 42 },
    { projectId: 'valid', appId: 'not-reverse-dns' }, { projectId: 'valid', appId: {} },
  ]) {
    await assert.rejects(initializeProject(options(projectRoot, body, runCommand)), { code: 'invalid_request' });
  }
  assert.equal(called, false);
  assert.equal(projectInitRequest({ projectId: 'a' }).appId, 'com.jiezi.miniapp.a');
});

test('never overwrites non-empty or symlink destinations', async (t) => {
  const projectRoot = fixture(t);
  const occupied = join(projectRoot, 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'sentinel.txt'), 'user work');
  await assert.rejects(
    initializeProject(options(projectRoot, { projectId: 'occupied' }, scaffold)),
    { code: 'project_exists' },
  );
  assert.equal(readFileSync(join(occupied, 'sentinel.txt'), 'utf8'), 'user work');

  const external = mkdtempSync(join(tmpdir(), 'jiezi-project-external-'));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  symlinkSync(external, join(projectRoot, 'linked'), 'dir');
  await assert.rejects(
    initializeProject(options(projectRoot, { projectId: 'linked' }, scaffold)),
    { code: 'project_exists' },
  );
  assert.deepEqual(readdirSync(external), []);
});

test('cleans failed staging and preserves a pre-existing empty destination', async (t) => {
  const projectRoot = fixture(t);
  const destination = join(projectRoot, 'failed-app');
  mkdirSync(destination);
  await assert.rejects(initializeProject(options(projectRoot, { projectId: 'failed-app' }, async (command, args) => {
    const dir = args.at(-1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'partial.txt'), 'partial');
    return { code: 1, stdout: '', stderr: 'synthetic init failure' };
  })), { code: 'init_failed', message: /synthetic init failure/ });
  assert.equal(existsSync(destination), true);
  assert.deepEqual(readdirSync(destination), []);
  assert.equal(readdirSync(projectRoot).some((name) => name.includes('.init-')), false);
});

test('reports whether the development certificate can sign the requested app id', async (t) => {
  const projectRoot = fixture(t);
  const skip = (command, args) => scaffold(command, args, []);
  const signable = await initializeProject(options(projectRoot, { projectId: 'signable-app' }, skip));
  assert.deepEqual(signable.signing, { certificate: 'com.jiezi.*', signable: true });
  assert.deepEqual(signable.warnings, []);

  const outside = await initializeProject(options(projectRoot, {
    projectId: 'outside-app', appId: 'com.example.outside',
  }, skip));
  assert.equal(outside.signing.certificate, 'com.jiezi.*');
  assert.equal(outside.signing.signable, false);
  assert.equal(outside.warnings.length, 1);
  assert.match(outside.warnings[0], /com\.example\.outside/);
  assert.match(outside.warnings[0], /com\.jiezi\.\*/);
});

test('certificate coverage accepts exact ids and the trailing-wildcard form only', () => {
  assert.equal(certificateCovers('com.jiezi.*', 'com.jiezi.miniapp.demo'), true);
  assert.equal(certificateCovers('com.jiezi.*', 'com.jiezi.'), true);
  assert.equal(certificateCovers('com.jiezi.*', 'com.jiezi'), false);
  assert.equal(certificateCovers('com.jiezi.*', 'org.jiezi.demo'), false);
  assert.equal(certificateCovers('com.jiezi.demo,com.example.*', 'com.example.app'), true);
  assert.equal(certificateCovers('com.jiezi.demo', 'com.jiezi.demo'), true);
  assert.equal(certificateCovers('com.jiezi.demo', 'com.jiezi.demo2'), false);
});

test('concurrent initialization has one winner and no partial overwrite', async (t) => {
  const projectRoot = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runCommand = async (command, args) => {
    await gate;
    return scaffold(command, args, []);
  };
  const attempts = [
    initializeProject(options(projectRoot, { projectId: 'same-app', name: 'First' }, runCommand)),
    initializeProject(options(projectRoot, { projectId: 'same-app', name: 'Second' }, runCommand)),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'project_exists');
  const appDir = join(projectRoot, 'same-app');
  assert.match(readFileSync(join(appDir, 'App.tsx'), 'utf8'), /JieZi Mini App/);
  assert.equal(readdirSync(projectRoot).some((name) => name.includes('.init-')), false);
});

test('resolveCallRoot prefers the caller root and rejects unusable paths', (t) => {
  const configured = fixture(t);
  const workspace = fixture(t);
  const nested = mkdtempSync(join(workspace, 'project-'));
  t.after(() => rmSync(nested, { recursive: true, force: true }));

  assert.equal(resolveCallRoot(configured, undefined), realpathSync(configured));
  assert.equal(resolveCallRoot(configured, workspace), realpathSync(workspace));
  assert.throws(() => resolveCallRoot(configured, 'relative/root'), { code: 'invalid_request' });
  assert.throws(() => resolveCallRoot(configured, ''), { code: 'invalid_request' });
  assert.throws(() => resolveCallRoot(configured, join(workspace, 'missing')), { code: 'invalid_request' });
  assert.throws(() => resolveCallRoot(configured, join(workspace, 'file.txt')), { code: 'invalid_request' });
});

test('the layout decides whether the working directory or a subdirectory is the project', (t) => {
  const configured = realpathSync(fixture(t));
  const workspace = realpathSync(fixture(t));
  assert.equal(initDestination(workspace, 'working-directory', 'app', true), workspace);
  assert.equal(initDestination(workspace, 'named-subdirectory', 'app', true), join(workspace, 'app'));
  assert.equal(initDestination(configured, 'working-directory', 'app', false), join(configured, 'app'));
  assert.equal(resolveProjectLayout(undefined), 'working-directory');
  assert.equal(resolveProjectLayout('named-subdirectory'), 'named-subdirectory');
  assert.throws(() => resolveProjectLayout('subdir'), { code: 'invalid_request' });
});

test('scaffolds the exact destination when the caller passes one', async (t) => {
  const workspace = fixture(t);
  const result = await initializeProject({
    body: { projectId: 'root-app' },
    destination: workspace,
    nshPath: '/pinned/nsh',
    runCommand: (command, args) => scaffold(command, args, []),
  });
  assert.equal(result.projectDir, realpathSync(workspace));
  assert.match(readFileSync(join(workspace, 'App.tsx'), 'utf8'), /testID="counter-increment"/);

  const other = fixture(t);
  writeFileSync(join(other, 'keep.txt'), 'user work');
  await assert.rejects(initializeProject({
    body: { projectId: 'root-app' },
    destination: other,
    nshPath: '/pinned/nsh',
    runCommand: (command, args) => scaffold(command, args, []),
  }), { code: 'project_exists', message: /named-subdirectory/ });
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'user work');
});


test('a Markdown-active name is neutralized so the scaffold passes the .jz validators', async (t) => {
  const projectRoot = fixture(t);
  const name = 'A <b> B `code` [x][y] foo:bar user@example.com';
  const result = await initializeProject(options(projectRoot, { projectId: 'hostile-name', name }, (command, args) => scaffold(command, args, [])));
  const about = readFileSync(join(result.projectDir, 'docs', 'about.md'), 'utf8');
  const presentation = JSON.parse(readFileSync(join(result.projectDir, 'jiezi.json'), 'utf8'));
  // The generated files are exactly what miniapp_build and the iOS reader run.
  assert.doesNotThrow(() => validateDescription(Buffer.from(about, 'utf8')));
  assert.doesNotThrow(() => validateSummary(presentation.summary));
  assert.match(about, /# A/);
  for (const active of ['<b>', '`', '[x][y]', 'foo:bar', 'user@example.com']) {
    assert.equal(about.includes(active), false, `about.md still contains ${active}`);
  }
});

test('a lone surrogate name is rejected before any file is created', async (t) => {
  const projectRoot = fixture(t);
  await assert.rejects(
    initializeProject(options(projectRoot, { projectId: 'surrogate', name: 'Demo\ud800' }, (command, args) => scaffold(command, args, []))),
    { code: 'invalid_request' },
  );
  assert.deepEqual(readdirSync(projectRoot), []);
});

test('a scaffolded sensitive declaration gets a valid synthesized purpose', async (t) => {
  const projectRoot = fixture(t);
  const withCapabilities = async (command, args) => {
    const dir = args.at(-1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'App.tsx'), '// official scaffold\n');
    writeFileSync(join(dir, 'tsconfig.json'), '{"extends":"./.nsh/tsconfig.json"}\n');
    writeFileSync(join(dir, 'nsh.json'), JSON.stringify({
      name: 'staging', id: 'com.example.staging', version: '0.0.1', build: 0,
      capabilities: { clipboard: true, camera: true },
    }));
    return Promise.resolve({ code: 0, stdout: 'created', stderr: '' });
  };
  const result = await initializeProject(options(projectRoot, { projectId: 'purpose-app' }, withCapabilities));
  const presentation = JSON.parse(readFileSync(join(result.projectDir, 'jiezi.json'), 'utf8'));
  const metadata = JSON.parse(readFileSync(join(result.projectDir, 'nsh.json'), 'utf8'));
  // `camera` is not an NSH 0.6.0 sensitive id; only `clipboard` needs text.
  assert.deepEqual(Object.keys(presentation.capabilityPurposes), ['clipboard']);
  assert.deepEqual(JZ_SENSITIVE_CAPABILITIES.includes('clipboard'), true);
  assert.doesNotThrow(() => validatePurposes(
    presentation.capabilityPurposes,
    metadata.capabilities,
    JZ_SENSITIVE_CAPABILITIES,
  ));
});

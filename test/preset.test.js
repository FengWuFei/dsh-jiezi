import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
const presetBlock = patch.slice(patch.indexOf('    - id: preset-jiezi'));

/** Row ids inside the preset block, in declaration order. */
function rowIds(block) {
  return [...block.matchAll(/^          - id: ([A-Za-z0-9._-]+)$/gm)].map((match) => match[1]);
}

test('芥子开发模式 is the shipped standard composition plus jiezi-tools', () => {
  assert.match(presetBlock, /^ {8}id: jiezi$/m);
  assert.match(presetBlock, /^ {8}name: 芥子开发模式$/m);
  assert.match(presetBlock, /^ {8}order: 20$/m);

  const expectedStandard = [
    'persona',
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'tool-schedule',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'planning',
    'compaction',
    'delegation',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'tool-office',
    'tool-plugin-manager',
    'tool-plugin-market',
  ];
  assert.deepEqual(rowIds(presetBlock), [...expectedStandard, 'jiezi-tools']);
  assert.equal(new Set(rowIds(presetBlock)).size, rowIds(presetBlock).length);
  assert.match(presetBlock, /name: 'dsh-jiezi\/tools'/);
  assert.match(presetBlock, /activationSkills: \['jiezi-miniapp'\]/);
  assert.doesNotMatch(presetBlock, /@deepseek-ai\/dsh-tool-cordis/);
  assert.match(presetBlock, /@deepseek-ai\/dsh-tool-web/);
  assert.match(patch, /autoStart: true/);
});

test('the profile-bundle skill root uses the installation anchor and .asar.unpacked', () => {
  assert.match(presetBlock, /DSH_INSTALL_DIR/);
  assert.match(presetBlock, /\.asar\.unpacked/);
  assert.match(presetBlock, /createRequire\(/);
});

test('the preset resolves the bundle-owned mini-app skill root', () => {
  const line = presetBlock.split('\n').find((entry) =>
    entry.includes('- !!js ') && entry.includes("resolve('dsh-jiezi')"),
  );
  assert.ok(line, 'bundle skill root is registered');
  const expression = line.slice(line.indexOf('- !!js ') + '- !!js '.length);
  const baseUrl = pathToFileURL(join(root, 'cordis.patch.yml')).href;
  const skillRoot = vm.runInNewContext(expression, { process, baseUrl });
  assert.equal(skillRoot, join(root, 'skills'));

  const runtimeBlock = patch.slice(0, patch.indexOf('    - id: preset-jiezi'));
  assert.doesNotMatch(runtimeBlock, /customSkillDirs|registerProvider|jiezi-miniapp/);
  assert.equal((patch.match(/customSkillDirs:/g) ?? []).length, 1);
});

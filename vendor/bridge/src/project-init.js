// Safe, one-call project initialization under the bridge's configured root.
// The official pinned NSH CLI owns the base scaffold; JieZi owns only the small
// template overlay and its bundled native adapter.

import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_CERT_APPS, run, synthesizedPurposeFor } from './build.js';
import { JZ_SENSITIVE_CAPABILITIES } from './jz.js';
import { declaredCapabilityIDs, validatePurposes, validateSummary } from './jz-manifest.js';
import { neutralizedMarkdownText, validateDescription } from './jz-media.js';
import { ProtocolError } from './protocol.js';

export const BASIC_TEMPLATE = 'jiezi-basic@1';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Whether one app id is covered by a comma-separated app pattern list such as
 * `com.jiezi.*`. Only the trailing-wildcard and exact forms are produced by
 * `nsh certify`, so those are the only two accepted here.
 */
export function certificateCovers(apps, appId) {
  return String(apps).split(',').some((entry) => {
    const pattern = entry.trim();
    if (pattern === '') return false;
    return pattern.endsWith('*') ? appId.startsWith(pattern.slice(0, -1)) : appId === pattern;
  });
}

/** Why an app id outside the development certificate cannot be signed. */
export function signingWarning(appId) {
  return `appId ${appId} is outside the development certificate scope ${DEV_CERT_APPS}; miniapp_build cannot sign it until a certificate covering that id is configured.`;
}

/** Source uses ../templates beside src; the packaged bridge uses ./templates. */
function bundledDirectory(name) {
  for (const path of [join(MODULE_DIR, '..', 'templates', name), join(MODULE_DIR, 'templates', name)]) {
    if (existsSync(path)) return path;
  }
  throw new Error(`bundled project template is missing: ${name}`);
}

const TEMPLATE_DIR = bundledDirectory('basic');
const ADAPTER_DIR = bundledDirectory('adapter');
const OVERLAY_FILES = ['App.tsx', 'App.test.tsx'];

function displayName(projectId) {
  return projectId.split('-').map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

/** Validate the narrow public request; caller paths are deliberately absent. */
export function projectInitRequest(body) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const projectId = String(value.projectId ?? '');
  if (projectId.length > 48 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(projectId)) {
    throw new ProtocolError('invalid_request', 'projectId must be 1–48 chars: lowercase letters/digits/hyphens, starting with a letter');
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw new ProtocolError('invalid_request', 'name must be a string');
  }
  const name = value.name === undefined ? displayName(projectId) : value.name.trim();
  // A lone UTF-16 surrogate is legal JSON but not a Unicode scalar value; it
  // would be written into `jiezi.json` and refused by the iOS reader.
  if (name.length < 1 || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || !name.isWellFormed()) {
    throw new ProtocolError('invalid_request', 'name must be 1–80 printable characters');
  }
  const derivedId = `com.jiezi.miniapp.${projectId.replaceAll('-', '')}`;
  if (value.appId !== undefined && typeof value.appId !== 'string') {
    throw new ProtocolError('invalid_request', 'appId must be a string');
  }
  const appId = value.appId === undefined ? derivedId : value.appId;
  if (appId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(appId)) {
    throw new ProtocolError('invalid_request', 'appId must be a reverse-DNS identifier such as com.example.myapp');
  }
  return { projectId, name, appId };
}

/**
 * Accept only an absent destination or an existing real, empty directory.
 * `hint` names the caller's layout so a refusal explains the fix.
 */
function assertDestinationAvailable(path, hint) {
  if (!existsSync(path)) return 'missing';
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(path).length > 0) {
    throw new ProtocolError('project_exists',
      `destination already exists and is not an empty real directory; no files were changed.${hint ?? ''}`);
  }
  return 'empty';
}

function initFailure(message) {
  return new ProtocolError('init_failed', `nsh init failed: ${message.slice(0, 2000)}`);
}

function writeMetadata(staging, request) {
  const path = join(staging, 'nsh.json');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw initFailure('the generated project has no valid nsh.json');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw initFailure('the generated nsh.json is not an object');
  }
  writeFileSync(path, `${JSON.stringify({
    ...metadata,
    name: request.name,
    id: request.appId,
    version: '1.0.0',
    build: 1,
  }, null, 2)}\n`);
}

/**
 * Writes the JieZi presentation files the `.jz` container requires.
 *
 * The request name is user text; it is neutralized for Markdown before it
 * reaches `docs/about.md` so a name such as `A <b> B` or ``A `b` B`` cannot
 * create a project the media validators (or the iOS reader) refuse. The
 * generated files
 * are validated here so `miniapp_init` can never hand out a project that
 * `miniapp_build` immediately rejects. A declared sensitive capability gets
 * the same neutral synthesized purpose the legacy-project migration uses.
 */
function writePresentation(staging, request) {
  const summary = `${request.name} mini app.`.slice(0, 120);
  const title = neutralizedMarkdownText(request.name);
  // appId is the strict reverse-DNS pattern checked above, so it is safe text
  // on its own; the neutralized title cannot open HTML, a code span or a link.
  const about = [
    `# ${title}`,
    '',
    `${title} is a JieZi mini-app (${request.appId}).`,
    '',
  ].join('\n');
  let capabilityPurposes = {};
  try {
    const metadata = JSON.parse(readFileSync(join(staging, 'nsh.json'), 'utf8'));
    const declaration = metadata.capabilities ?? {};
    const declared = declaredCapabilityIDs(declaration);
    for (const id of JZ_SENSITIVE_CAPABILITIES) {
      if (declared.has(id)) capabilityPurposes[id] = synthesizedPurposeFor(id);
    }
    validateSummary(summary);
    validateDescription(Buffer.from(about, 'utf8'));
    validatePurposes(capabilityPurposes, declaration, JZ_SENSITIVE_CAPABILITIES);
  } catch (error) {
    throw new ProtocolError('init_failed', `generated presentation files are invalid: ${error.message}`);
  }
  writeFileSync(join(staging, 'jiezi.json'), `${JSON.stringify({
    schemaVersion: 1,
    summary,
    capabilityPurposes,
  }, null, 2)}\n`);
  mkdirSync(join(staging, 'docs'), { recursive: true });
  writeFileSync(join(staging, 'docs', 'about.md'), `${about}\n`);
}

function applyTemplate(staging, request, templateDir, adapterDir) {
  for (const file of OVERLAY_FILES) copyFileSync(join(templateDir, file), join(staging, file));
  // npm excludes .gitignore even below a packaged template; ship a safe name.
  copyFileSync(join(templateDir, 'gitignore.template'), join(staging, '.gitignore'));
  const readme = readFileSync(join(templateDir, 'README.md'), 'utf8')
    .replaceAll('{{PROJECT_NAME}}', request.name)
    .replaceAll('{{PROJECT_ID}}', request.projectId)
    .replaceAll('{{APP_ID}}', request.appId);
  writeFileSync(join(staging, 'README.md'), readme);

  const adapterPackage = JSON.parse(readFileSync(join(adapterDir, 'package.json'), 'utf8'));
  const adapterDestination = join(staging, 'node_modules', 'jiezi', 'native');
  mkdirSync(join(staging, 'node_modules', 'jiezi'), { recursive: true });
  cpSync(adapterDir, adapterDestination, { recursive: true, force: false, errorOnExist: true });
  return String(adapterPackage.version ?? 'unknown');
}

/**
 * Initialize one project through fixed NSH argv, then atomically publish it.
 * `runCommand` is an internal test seam; production always uses build.run.
 */
export async function initializeProject(options) {
  const request = projectInitRequest(options.body);
  const signable = certificateCovers(DEV_CERT_APPS, request.appId);
  const warnings = signable ? [] : [signingWarning(request.appId)];
  // The Host may pass the exact destination (the Session working directory);
  // tests and the named layout pass a root and get <root>/<projectId>.
  const destination = options.destination === undefined
    ? join(realpathSync(options.projectRoot), request.projectId)
    : options.destination;
  const hint = options.destination === undefined
    ? ''
    : ' Open an empty directory, or set projectLayout to named-subdirectory.';
  assertDestinationAvailable(destination, hint);

  const templateDir = options.templateDir ?? TEMPLATE_DIR;
  const adapterDir = options.adapterDir ?? ADAPTER_DIR;
  const runCommand = options.runCommand ?? run;
  const staging = join(dirname(destination), `.${request.projectId}.init-${process.pid}-${randomUUID().replaceAll('-', '')}`);
  let stagingExists = false;
  let removedEmptyDestination = false;
  let committed = false;
  try {
    mkdirSync(staging, { mode: 0o700 });
    stagingExists = true;
    const result = await runCommand(
      options.nshPath,
      ['init', '--template', 'ts', '--name', request.name, staging],
      { timeoutMs: 60_000 },
    );
    if (result.code !== 0) throw initFailure(result.stderr || result.stdout || `exit ${result.code}`);
    if (!existsSync(join(staging, 'App.tsx')) || !existsSync(join(staging, 'tsconfig.json'))) {
      throw initFailure('the generated project is incomplete');
    }

    writeMetadata(staging, request);
    writePresentation(staging, request);
    const adapterVersion = applyTemplate(staging, request, templateDir, adapterDir);

    // Recheck immediately before commit. A concurrent non-empty project wins;
    // this call never merges with or replaces it.
    const state = assertDestinationAvailable(destination, hint);
    if (state === 'empty') {
      rmdirSync(destination);
      removedEmptyDestination = true;
    }
    renameSync(staging, destination);
    stagingExists = false;
    committed = true;

    return {
      ok: true,
      projectId: request.projectId,
      projectDir: realpathSync(destination),
      name: request.name,
      appId: request.appId,
      template: BASIC_TEMPLATE,
      adapter: `jiezi/native@${adapterVersion}`,
      signing: { certificate: DEV_CERT_APPS, signable },
      warnings,
      files: ['.gitignore', 'App.test.tsx', 'App.tsx', 'README.md', 'docs/about.md', 'jiezi.json', 'nsh.json', 'tsconfig.json'],
    };
  } finally {
    if (stagingExists) rmSync(staging, { recursive: true, force: true });
    if (removedEmptyDestination && !committed && !existsSync(destination)) {
      mkdirSync(destination, { mode: 0o700 });
    }
  }
}

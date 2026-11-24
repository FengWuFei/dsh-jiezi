// `.jz` v1 manifest validation and the source-project presentation rules
// (034 plan §4.2, §4.4).

import { JZ_ENTRY, JZ_FORMAT, JZ_FORMAT_VERSION, JZ_LIMITS, jzError } from './jz.js';

const BUILD_MAX = Number.MAX_SAFE_INTEGER;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_FIELDS = new Set([
  'format', 'formatVersion', 'critical', 'createdAt', 'app', 'runtime',
  'presentation', 'capabilities', 'files',
]);
const APP_FIELDS = new Set(['id', 'name', 'version', 'build']);
const RUNTIME_FIELDS = new Set(['payload', 'minRuntime']);
const PRESENTATION_FIELDS = new Set(['summary', 'description', 'icon']);
const CAPABILITY_FIELDS = new Set(['declaration', 'purposes']);
const FILE_FIELDS = new Set(['path', 'byteSize', 'sha256']);

/**
 * Every dotted field name this reader understands. A `critical` entry only
 * passes when it is one of these; a future restriction forces an older reader
 * to refuse instead of ignoring it.
 */
const KNOWN_CRITICAL = new Set([
  ...[...MANIFEST_FIELDS].map((name) => name),
  ...[...APP_FIELDS].map((name) => `app.${name}`),
  ...[...RUNTIME_FIELDS].map((name) => `runtime.${name}`),
  ...[...PRESENTATION_FIELDS].map((name) => `presentation.${name}`),
  ...[...CAPABILITY_FIELDS].map((name) => `capabilities.${name}`),
  ...[...FILE_FIELDS].map((name) => `files.${name}`),
]);

/** Counts Unicode scalar values, so an emoji is one character. */
export function scalarCount(text) {
  return [...text].length;
}

/** Whether a string contains a C0/C1 control character. */
function hasControlCharacter(text) {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/**
 * Text that is displayable and round-trips through every reader: no C0/C1
 * control characters and no unpaired UTF-16 surrogate. A lone surrogate
 * (`"\ud800"`) is legal JSON but not a Unicode scalar value; Foundation's JSON
 * decoder and Swift `String` refuse it, so the producer must never emit one.
 */
function hasInvalidText(text) {
  return hasControlCharacter(text) || !text.isWellFormed();
}

/**
 * The declared capability ids of one `nsh.json` declaration (034 plan D1).
 * Each value is one of the shapes NSH accepts: a boolean (`"clipboard": true`),
 * an object (`"openUrl": {"schemes": ["https"]}`) or an array of strings
 * (`"host": ["storage.file.*"]`). A top-level key whose value is not `false`
 * declares that id; `"host": true` declares `host`. Any other shape is a
 * manifest error.
 */
export function declaredCapabilityIDs(declaration) {
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw jzError('JZ_BAD_MANIFEST', 'capabilities.declaration must be a JSON object');
  }
  const ids = new Set();
  for (const [key, value] of Object.entries(declaration)) {
    if (value === false) continue;
    if (value === true) {
      ids.add(key);
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.every((item) => typeof item === 'string')) {
        throw jzError('JZ_BAD_MANIFEST', `capabilities.declaration.${key} must be an array of strings`);
      }
      ids.add(key);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      ids.add(key);
      continue;
    }
    throw jzError(
      'JZ_BAD_MANIFEST',
      `capabilities.declaration.${key} must be a boolean, object or array of strings`,
    );
  }
  return ids;
}

/** Validates the summary text (`jiezi.json`). */
export function validateSummary(summary) {
  if (typeof summary !== 'string') throw jzError('JZ_BAD_MANIFEST', 'jiezi.json summary must be a string');
  const trimmed = summary.trim();
  if (trimmed.length === 0) throw jzError('JZ_BAD_MANIFEST', 'jiezi.json summary must not be empty');
  if (scalarCount(trimmed) > JZ_LIMITS.summaryScalars) {
    throw jzError('JZ_BAD_MANIFEST', `summary exceeds ${JZ_LIMITS.summaryScalars} characters`);
  }
  if (hasInvalidText(trimmed)) throw jzError('JZ_BAD_MANIFEST', 'summary contains a control character');
  return trimmed;
}

/**
 * Validates capability purposes against the declaration. Returns the trimmed
 * map. The refusal codes are fixed by 034 plan D6: an invalid purpose value is
 * a manifest error, a purpose for an undeclared key is an unknown purpose, and
 * a missing purpose for a declared sensitive capability is a missing purpose.
 * @param {Record<string, string>} purposes
 * @param {unknown} declaration
 * @param {Iterable<string>} sensitive
 */
export function validatePurposes(purposes, declaration, sensitive) {
  if (purposes === undefined || purposes === null) purposes = {};
  if (typeof purposes !== 'object' || Array.isArray(purposes)) {
    throw jzError('JZ_BAD_MANIFEST', 'capabilityPurposes must be an object');
  }
  const declared = declaredCapabilityIDs(declaration);
  const sensitiveSet = new Set(sensitive);
  const result = {};
  for (const [key, value] of Object.entries(purposes)) {
    if (typeof value !== 'string') {
      throw jzError('JZ_BAD_MANIFEST', `purpose for ${key} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw jzError('JZ_BAD_MANIFEST', `purpose for ${key} must not be empty`);
    }
    if (scalarCount(trimmed) > JZ_LIMITS.purposeScalars) {
      throw jzError('JZ_BAD_MANIFEST', `purpose for ${key} exceeds ${JZ_LIMITS.purposeScalars} characters`);
    }
    if (hasInvalidText(trimmed)) {
      throw jzError('JZ_BAD_MANIFEST', `purpose for ${key} contains a control character`);
    }
    if (!declared.has(key)) {
      throw jzError('JZ_UNKNOWN_PURPOSE', `purpose names ${key}, which the app does not declare`);
    }
    result[key] = trimmed;
  }
  for (const id of sensitiveSet) {
    if (declared.has(id) && result[id] === undefined) {
      throw jzError('JZ_MISSING_PURPOSE', `the app declares ${id} but gives no purpose`);
    }
  }
  return result;
}

/**
 * Validates `jiezi.json`. The file owns presentation text and purposes only;
 * identity, version, build and capabilities come from `nsh.json`.
 * @returns {{schemaVersion: number, summary: string, capabilityPurposes: Record<string, string>}}
 */
export function validateJieziJSON(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'jiezi.json must be a JSON object');
  }
  if (value.schemaVersion !== 1) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `jiezi.json schemaVersion must be 1, got ${String(value.schemaVersion)}`);
  }
  const summary = validateSummary(value.summary);
  const purposes = value.capabilityPurposes ?? {};
  if (typeof purposes !== 'object' || Array.isArray(purposes)) {
    throw jzError('JZ_BAD_MANIFEST', 'capabilityPurposes must be an object');
  }
  for (const [key, text] of Object.entries(purposes)) {
    if (typeof text !== 'string' || scalarCount(text.trim()) > JZ_LIMITS.purposeScalars || hasInvalidText(String(text))) {
      throw jzError('JZ_BAD_MANIFEST', `invalid purpose for ${key}`);
    }
  }
  return { schemaVersion: 1, summary, capabilityPurposes: { ...purposes } };
}

/**
 * Builds the manifest object. Hashes and sizes come from the assembled files,
 * so the caller cannot declare a value the container does not hold.
 */
export function buildManifest({ app, minRuntime, summary, purposes, declaration, files, createdAt }) {
  return {
    format: JZ_FORMAT,
    formatVersion: JZ_FORMAT_VERSION,
    critical: [],
    createdAt,
    app: {
      id: app.id,
      name: app.name,
      version: app.version,
      build: app.build,
    },
    runtime: { payload: JZ_ENTRY.payload, minRuntime },
    presentation: {
      summary,
      description: JZ_ENTRY.description,
      ...(files.some((file) => file.path === JZ_ENTRY.icon) ? { icon: JZ_ENTRY.icon } : {}),
    },
    capabilities: {
      declaration,
      purposes,
    },
    files: files
      .slice()
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
  };
}

/**
 * Validates a parsed manifest against the container's entries and the
 * supported field set. Unknown optional fields are ignored; a name listed in
 * `critical` must be known or the package is refused.
 */
export function validateManifest(raw, entries) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest must be a JSON object');
  }
  if (raw.format !== JZ_FORMAT) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `manifest format must be ${JZ_FORMAT}`);
  }
  if (raw.formatVersion !== JZ_FORMAT_VERSION) {
    throw jzError('JZ_UNSUPPORTED_FORMAT', `manifest formatVersion must be ${JZ_FORMAT_VERSION}`);
  }
  // `critical` is absent or an array of strings; `null` and every other shape
  // are a manifest error (D7), not an implicit empty array.
  const critical = raw.critical === undefined ? [] : raw.critical;
  if (!Array.isArray(critical) || !critical.every((name) => typeof name === 'string')) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest critical must be an array of strings');
  }
  for (const name of critical) {
    if (!KNOWN_CRITICAL.has(name)) {
      throw jzError('JZ_CRITICAL_FIELD', `manifest requires the unknown field ${name}`);
    }
  }

  const createdAt = parseTimestamp(raw.createdAt);
  const app = validateApp(raw.app);
  const runtime = validateRuntime(raw.runtime);
  const presentation = validatePresentation(raw.presentation);
  const capabilities = validateCapabilities(raw.capabilities);
  const files = validateFiles(raw.files);

  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const fileByPath = new Map();
  for (const file of files) {
    if (fileByPath.has(file.path)) throw jzError('JZ_BAD_MANIFEST', `duplicate manifest file entry ${file.path}`);
    fileByPath.set(file.path, file);
  }
  const listed = new Set(fileByPath.keys());
  const expected = new Set([
    JZ_ENTRY.payload,
    JZ_ENTRY.description,
    ...(presentation.icon === undefined ? [] : [JZ_ENTRY.icon]),
  ]);
  for (const path of expected) {
    if (!listed.has(path)) throw jzError('JZ_BAD_MANIFEST', `manifest does not list ${path}`);
  }
  for (const path of listed) {
    if (!expected.has(path)) throw jzError('JZ_BAD_MANIFEST', `manifest lists the unknown file ${path}`);
    if (!entryByName.has(path)) throw jzError('JZ_BAD_MANIFEST', `manifest lists ${path}, which the archive does not contain`);
  }
  if (presentation.icon === undefined && entryByName.has(JZ_ENTRY.icon)) {
    throw jzError('JZ_UNKNOWN_ENTRY', 'archive contains an icon the manifest does not declare');
  }

  return {
    format: JZ_FORMAT,
    formatVersion: JZ_FORMAT_VERSION,
    critical,
    createdAt,
    app,
    runtime,
    presentation,
    capabilities,
    files: files.slice().sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
  };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'createdAt must be an RFC 3339 UTC timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw jzError('JZ_BAD_MANIFEST', 'createdAt is not a real timestamp');
  return new Date(Math.floor(milliseconds / 1000) * 1000);
}

function validateApp(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest app must be an object');
  }
  if (typeof value.id !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value.id) || Buffer.byteLength(value.id) > 128) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest app.id is invalid');
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0
    || scalarCount(value.name) > JZ_LIMITS.nameScalars || hasInvalidText(value.name)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest app.name is invalid');
  }
  if (typeof value.version !== 'string' || value.version.length === 0
    || scalarCount(value.version) > JZ_LIMITS.versionScalars || hasInvalidText(value.version)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest app.version is invalid');
  }
  if (!Number.isSafeInteger(value.build) || value.build < 1 || value.build > BUILD_MAX) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest app.build must be a positive safe integer');
  }
  return { id: value.id, name: value.name, version: value.version, build: value.build };
}

function validateRuntime(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest runtime must be an object');
  }
  if (value.payload !== JZ_ENTRY.payload) {
    throw jzError('JZ_BAD_MANIFEST', `manifest runtime.payload must be ${JZ_ENTRY.payload}`);
  }
  // ASCII digits only; an ICU `\d` would also accept non-ASCII digits a
  // Swift reader refuses (D7).
  if (typeof value.minRuntime !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.minRuntime)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest runtime.minRuntime must be MAJOR.MINOR.PATCH');
  }
  return { payload: value.payload, minRuntime: value.minRuntime };
}

function validatePresentation(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest presentation must be an object');
  }
  const rawSummary = value.summary;
  if (typeof rawSummary !== 'string') {
    throw jzError('JZ_BAD_MANIFEST', 'manifest presentation.summary is invalid');
  }
  const summary = rawSummary.trim();
  if (summary.length === 0
    || scalarCount(summary) > JZ_LIMITS.summaryScalars
    || hasInvalidText(summary)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest presentation.summary is invalid');
  }
  if (value.description !== JZ_ENTRY.description) {
    throw jzError('JZ_BAD_MANIFEST', `manifest presentation.description must be ${JZ_ENTRY.description}`);
  }
  if (value.icon !== undefined && value.icon !== JZ_ENTRY.icon) {
    throw jzError('JZ_BAD_MANIFEST', `manifest presentation.icon must be ${JZ_ENTRY.icon}`);
  }
  return value.icon === undefined
    ? { summary, description: value.description }
    : { summary, description: value.description, icon: value.icon };
}

function validateCapabilities(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest capabilities must be an object');
  }
  declaredCapabilityIDs(value.declaration);
  if (value.purposes === undefined || value.purposes === null
    || typeof value.purposes !== 'object' || Array.isArray(value.purposes)) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest capabilities.purposes must be an object');
  }
  const purposes = {};
  for (const [key, text] of Object.entries(value.purposes)) {
    if (typeof text !== 'string') throw jzError('JZ_BAD_MANIFEST', `purpose for ${key} must be a string`);
    purposes[key] = text;
  }
  return { declaration: value.declaration, purposes };
}

function validateFiles(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw jzError('JZ_BAD_MANIFEST', 'manifest files must be a non-empty array');
  }
  const seen = new Set();
  const files = [];
  let previous = null;
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw jzError('JZ_BAD_MANIFEST', 'manifest file entries must be objects');
    }
    if (typeof entry.path !== 'string') throw jzError('JZ_BAD_MANIFEST', 'manifest file path must be a string');
    if (seen.has(entry.path)) throw jzError('JZ_BAD_MANIFEST', `duplicate manifest file ${entry.path}`);
    seen.add(entry.path);
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(entry.path)) >= 0) {
      throw jzError('JZ_BAD_MANIFEST', 'manifest files must be sorted by path');
    }
    previous = entry.path;
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) {
      throw jzError('JZ_BAD_MANIFEST', `manifest file ${entry.path} has an invalid size`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
      throw jzError('JZ_BAD_MANIFEST', `manifest file ${entry.path} needs a lowercase SHA-256`);
    }
    files.push({ path: entry.path, byteSize: entry.byteSize, sha256: entry.sha256 });
  }
  return files;
}

/** Manifest field names the v1 reader understands (for `critical` checks). */
export function knownManifestFields() {
  return {
    manifest: MANIFEST_FIELDS,
    app: APP_FIELDS,
    runtime: RUNTIME_FIELDS,
    presentation: PRESENTATION_FIELDS,
    capabilities: CAPABILITY_FIELDS,
    files: FILE_FIELDS,
  };
}

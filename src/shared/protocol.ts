/**
 * Protocol shared by the Host routes, the model-facing tools, and the browser
 * panel: route constants, the pairing payload, bridge result shapes, argument
 * validation, and bounded formatting. No I/O and no Node globals here, so the
 * same module is bundled into the Client half.
 */

import { JieZiError, invalid, toPublicError } from './errors.js';

/** Version tag carried inside the pairing QR payload. */
export const PAIRING_SCHEMA = 'jiezi.pairing.v1' as const;

/** Mount point of the authenticated Host routes. */
export const API_PREFIX = '/api/jiezi';

/**
 * Exact Auth-guarded routes. The Client resolves these against the document
 * base (no leading slash) so a path-prefixing mount keeps working, while the
 * Host registers the absolute form.
 */
export const API_ROUTES = {
  status: `${API_PREFIX}/status`,
  setup: `${API_PREFIX}/setup`,
  pairing: `${API_PREFIX}/pairing`,
  devices: `${API_PREFIX}/devices`,
  deploy: `${API_PREFIX}/deploy`,
  operation: `${API_PREFIX}/operation`,
  diagnostics: `${API_PREFIX}/diagnostics`,
  automation: `${API_PREFIX}/automation`,
  bridge: `${API_PREFIX}/bridge`,
  unpair: `${API_PREFIX}/unpair`,
} as const;

/** Browser-relative form of a Host route. */
export function clientRoute(path: string): string {
  return path.replace(/^\/+/, '');
}

/** Largest accepted JSON body on a Host route. */
export const MAX_API_BODY_BYTES = 16 * 1024;
/** Largest rendered tool result, matching the P0 tool contract. */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** Largest rendered automation outline inside a tool result. */
export const MAX_OUTLINE_CHARS = 12_000;
/** Most snapshot nodes rendered into an outline. */
export const MAX_OUTLINE_NODES = 120;
/** Pairing TTL bounds accepted by the Host route. */
export const MIN_PAIRING_TTL_MS = 30_000;
export const MAX_PAIRING_TTL_MS = 10 * 60_000;
export const DEFAULT_PAIRING_TTL_MS = 120_000;
/** Bounds applied to lists returned to the panel and tools. */
export const MAX_DEVICES = 50;
export const MAX_DEPLOYMENTS = 8;
export const MAX_AUTOMATION_HISTORY = 5;
export const MAX_INSTALLED_APPS = 12;
/** Polling cadence used by the panel while a pairing session is waiting. */
export const PAIRING_POLL_MS = 1_500;
/** Polling cadence used by the panel for the summary while mounted. */
export const STATUS_POLL_MS = 5_000;

/** Pairing state reported by the bridge. */
export type PairingState = 'waiting' | 'paired' | 'expired';

/** The one object encoded into the QR image. Exactly these six fields. */
export interface PairingPayload {
  schema: typeof PAIRING_SCHEMA;
  sessionId: string;
  endpoint: string;
  code: string;
  certificateFingerprint: string | null;
  expiresAt: string;
}

/**
 * Advisory minimum Host version. 0.1.x is the known legacy freeze-snapshot
 * implementation; change this one constant when the Host package chooses the
 * version of its next release. Compatibility is a warning, never a hard gate.
 */
export const MIN_HOST_VERSION = '0.2.0';

/** How a device's Host version relates to the supported contract. */
export type HostCompatibility = 'supported' | 'outdated' | 'unknown';

/** Compare dotted numeric versions; missing components are zero. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value
    .split(/[^0-9]+/u)
    .filter((item) => item.length > 0)
    .slice(0, 4)
    .map((item) => Number(item) || 0);
  const a = parts(left);
  const b = parts(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** Advisory Host compatibility; unknown does not block a deployment. */
export function hostCompatibility(version: string | null): HostCompatibility {
  if (version === null || version.length === 0) return 'unknown';
  return compareVersions(version, MIN_HOST_VERSION) >= 0 ? 'supported' : 'outdated';
}

/** One Host version line shared by tools, panel and doctor. */
export interface HostInfo {
  deviceId: string;
  version: string | null;
  minimumVersion: string;
  compatibility: HostCompatibility;
}

/** Panel view of one pairing session: the payload plus its live state. */
export interface PairingView {
  payload: PairingPayload | null;
  state: PairingState | 'none';
  deviceId: string | null;
  bridgeName: string | null;
  expiresAt: string | null;
}

/** One paired device, bounded for the panel. */
export interface DeviceView {
  deviceId: string;
  name: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  /** Bridge pairing: this device belongs to the JieZi bridge. */
  jieziPaired: boolean;
  /** CoreDevice/Xcode pairing, when a matching target is visible. */
  coreDevicePaired: boolean | null;
  /** The Host App currently has a live developer-mode connection. */
  hostRunning: boolean;
  hostVersion: string | null;
  hostMinimumVersion: string;
  hostCompatibility: HostCompatibility;
  boundHostDeviceId: string | null;
  nextAction: string | null;
  targetKind: 'physical' | 'simulator' | null;
  revocation: { developerMode: boolean; automation: boolean; updatedAt: string | null } | null;
  developerMode: boolean;
  automation: boolean;
  activeApp: {
    appId: string | null;
    releaseId: string | null;
    instanceId: string | null;
    installedApps: Array<{ appId: string; title: string; releaseId: string; state: string; active: boolean }>;
  } | null;
}

/** One recent delivery operation. */
export interface DeploymentView {
  opId: string;
  deviceId: string;
  releaseId: string;
  state: string;
  failureLayer: string | null;
  evidenceId: string | null;
  updatedAt: string | null;
}

/** One recent semantic automation outcome. */
export interface AutomationView {
  requestId: string;
  opId: string | null;
  deviceId: string;
  action: 'observe' | 'tap' | 'type' | 'scroll';
  state: string;
  appId: string | null;
  instanceId: string | null;
  nodeCount: number;
  error: { code: string; message: string; category?: 'device' | 'host' | 'runtime' | 'verification' } | null;
  hostAlert: AutomationAlert | null;
  updatedAt: string | null;
}

/** A Host alert covering the runtime; taps cannot reach the page behind it. */
export interface AutomationAlert {
  code: string;
  message: string;
  appId: string | null;
  releaseId: string | null;
  instanceId: string | null;
}

/** One bounded automation snapshot node. */
export interface SnapshotNode {
  alias: string | null;
  testID: string | null;
  label: string | null;
  role: string | null;
  value: string | null;
  frame: { x: number; y: number; width: number; height: number } | null;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  path: string | null;
}

/** One bounded semantic snapshot. */
export interface AutomationSnapshot {
  snapshotId: string | null;
  appId: string | null;
  releaseId: string | null;
  instanceId: string | null;
  mode: string;
  capabilities: string[];
  screen: { width: number; height: number } | null;
  nodes: SnapshotNode[];
  truncated: boolean;
  visibleNodeCount: number;
  hiddenNodeCount: number;
  duplicateTestIDs: string[];
}

/** One diagnostic event returned inline with an automation result. */
export interface AutomationDiagnosticEvent {
  sequence: number;
  level: string;
  code: string | null;
  message: string;
  timestamp: string | null;
}

/** Diagnostic sequences and bodies appended during one automation request. */
export interface AutomationDiagnostics {
  cursor: number;
  sequences: number[];
  events: AutomationDiagnosticEvent[];
}

/** Whole-panel summary returned by GET /api/jiezi/status. */
export interface StatusView {
  ok: true;
  bridge: {
    available: boolean;
    version: string | null;
    expectedVersion: string | null;
    identityMatch: boolean | null;
    bridgeName: string | null;
    deviceUrl: string | null;
    socketPath: string | null;
    projectRoot: string | null;
    nsh: { path: string | null; version: string | null } | null;
    install: { path: string; version: string | null; hash: string | null } | null;
    capabilities: string[];
    error: { code: string; message: string } | null;
  };
  setup: {
    initialized: boolean;
    stateDir: string;
    bridgeCliPath: string;
    bridgeCliAvailable: boolean;
  };
  pairing: PairingView;
  devices: DeviceView[];
  deployments: DeploymentView[];
  automation: AutomationView[];
  warnings: string[];
  fetchedAt: string;
}

/** One setup prerequisite check. */
export interface SetupCheck {
  id: string;
  ok: boolean;
  message: string;
}

/** Read-only environment report returned by GET /api/jiezi/setup. */
export interface SetupReport {
  ok: true;
  version: string | null;
  platform: string;
  arch: string;
  node: string;
  cli: { path: string; available: boolean };
  install: { path: string; version: string | null; hash: string | null } | null;
  state: { dir: string; initialized: boolean; configPath: string; keysPresent: boolean };
  socket: {
    path: string;
    running: boolean;
    version: string | null;
    startedAt: string | null;
    identityMatch: boolean | null;
    stale: boolean | null;
    nsh: string | null;
    error: string | null;
  };
  nsh: {
    found: boolean;
    configured: string | null;
    path: string | null;
    version: string | null;
    error: string | null;
    candidates: string[];
    candidateCount: number;
  };
  apple: { devicectl: boolean; simctl: boolean; note: string | null };
  checks: SetupCheck[];
  notes: string[];
  fixed?: boolean;
  fixes?: string[];
  checkedAt: string;
}

/** Bounded result of an explicit setup initialization. */
export interface SetupInitializeResult {
  ok: true;
  alreadyInitialized: boolean;
  host: '127.0.0.1' | '0.0.0.0';
  tls: boolean;
  init: {
    stateDir: string | null;
    socket: string | null;
    projectRoot: string | null;
    nsh: string | null;
    devKey: { keyId: string | null; path: string | null } | null;
    tls: { fingerprint: string | null } | null;
  } | null;
  report: SetupReport;
}

/** Start of the bounded tool failure shape. */
export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

/** Normalize any thrown value into a tool result object. */
export function toolFailure(error: unknown): ToolFailure {
  const body = toPublicError(error);
  return { ok: false, code: body.error.code, message: body.error.message, retryable: body.error.retryable };
}

/* ------------------------------------------------------------------ values */

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${what} must be an object`);
  return value as Record<string, unknown>;
}

/** Required non-empty string with a length bound. */
export function requireString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} must be a non-empty string`);
  if (value.length > max) throw invalid(`${name} must be at most ${max} characters`);
  return value;
}

/** Optional string with a length bound; undefined stays undefined. */
export function optionalString(value: unknown, name: string, max = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, max);
}

/** Clamp a numeric option into a range, applying a default. */
export function boundedNumber(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw invalid(`${name} must be a number`);
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

/* ------------------------------------------------------- pairing payload */

/**
 * Validate the exact QR object. Extra keys are rejected so the encoded content
 * stays the six agreed fields even if a bridge response grows.
 */
export function validatePairingPayload(value: unknown): PairingPayload {
  const record = asRecord(value, 'pairing payload');
  const keys = Object.keys(record).sort();
  const expected = ['certificateFingerprint', 'code', 'endpoint', 'expiresAt', 'schema', 'sessionId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid(`pairing payload must carry exactly: ${expected.join(', ')}`);
  }
  if (record.schema !== PAIRING_SCHEMA) throw invalid(`pairing payload schema must be ${PAIRING_SCHEMA}`);
  const fingerprint = record.certificateFingerprint;
  if (fingerprint !== null && typeof fingerprint !== 'string') throw invalid('certificateFingerprint must be a string or null');
  if (typeof fingerprint === 'string' && fingerprint.length > 256) throw invalid('certificateFingerprint is too long');
  const expiresAt = requireString(record.expiresAt, 'expiresAt', 64);
  if (Number.isNaN(Date.parse(expiresAt))) throw invalid('expiresAt must be an ISO-8601 timestamp');
  return {
    schema: PAIRING_SCHEMA,
    sessionId: requireString(record.sessionId, 'sessionId', 128),
    endpoint: requireString(record.endpoint, 'endpoint', 512),
    code: requireString(record.code, 'code', 64),
    certificateFingerprint: fingerprint,
    expiresAt,
  };
}

/** The exact text encoded into the QR image. */
export function pairingPayloadText(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

/* ------------------------------------------------------------- arguments */

export interface InitArgs {
  projectId: string;
  name?: string;
  appId?: string;
}

export function parseInitArgs(args: unknown): InitArgs {
  const value = asRecord(args, 'arguments');
  const result: InitArgs = { projectId: requireString(value.projectId, 'projectId', 48) };
  const name = optionalString(value.name, 'name', 80);
  const appId = optionalString(value.appId, 'appId', 128);
  if (name !== undefined) result.name = name;
  if (appId !== undefined) result.appId = appId;
  return result;
}

export interface BuildArgs {
  projectId: string;
  projectDir?: string;
}

export function parseBuildArgs(args: unknown): BuildArgs {
  const value = asRecord(args, 'arguments');
  const result: BuildArgs = { projectId: requireString(value.projectId, 'projectId', 256) };
  const projectDir = optionalString(value.projectDir, 'projectDir', 4096);
  if (projectDir !== undefined) result.projectDir = projectDir;
  return result;
}

export interface DeployArgs {
  deviceId: string;
  releaseId: string;
  force: boolean;
}

export function parseDeployArgs(args: unknown): DeployArgs {
  const value = asRecord(args, 'arguments');
  if (value.force !== undefined && typeof value.force !== 'boolean') throw invalid('force must be a boolean');
  return {
    deviceId: requireString(value.deviceId, 'deviceId', 256),
    releaseId: requireString(value.releaseId, 'releaseId', 256),
    force: value.force === true,
  };
}

export interface StatusArgs {
  opId?: string;
  deviceId?: string;
}

export function parseStatusArgs(args: unknown): StatusArgs {
  const value = asRecord(args, 'arguments');
  const result: StatusArgs = {};
  const opId = optionalString(value.opId, 'opId', 256);
  const deviceId = optionalString(value.deviceId, 'deviceId', 256);
  if (opId !== undefined) result.opId = opId;
  if (deviceId !== undefined) result.deviceId = deviceId;
  return result;
}

export interface DiagnosticsArgs {
  opId?: string;
  evidenceId?: string;
}

export function parseDiagnosticsArgs(args: unknown): DiagnosticsArgs {
  const value = asRecord(args, 'arguments');
  const result: DiagnosticsArgs = {};
  const opId = optionalString(value.opId, 'opId', 256);
  const evidenceId = optionalString(value.evidenceId, 'evidenceId', 256);
  if (opId !== undefined) result.opId = opId;
  if (evidenceId !== undefined) result.evidenceId = evidenceId;
  if (result.opId === undefined && result.evidenceId === undefined) {
    throw invalid('opId or evidenceId is required');
  }
  return result;
}

export interface CaptureArgs {
  deviceId: string;
  waitMs: number;
  requestId?: string;
}

export function parseCaptureArgs(args: unknown): CaptureArgs {
  const value = asRecord(args, 'arguments');
  const result: CaptureArgs = {
    deviceId: requireString(value.deviceId, 'deviceId', 256),
    waitMs: boundedNumber(value.waitMs, 'waitMs', 5_000, 0, 15_000),
  };
  const requestId = optionalString(value.requestId, 'requestId', 256);
  if (requestId !== undefined) result.requestId = requestId;
  return result;
}

export interface OpenArgs {
  deviceId: string;
  appId: string;
  timeoutMs: number;
}

/** Validate one open-installed-app request. */
export function parseOpenArgs(args: unknown): OpenArgs {
  const value = asRecord(args, 'arguments');
  return {
    deviceId: requireString(value.deviceId, 'deviceId', 256),
    appId: requireString(value.appId, 'appId', 128),
    timeoutMs: boundedNumber(value.timeoutMs, 'timeoutMs', 15_000, 1_000, 30_000),
  };
}

export interface ScreenArgs {
  deviceId: string;
  hostDeviceId?: string;
}

/** Validate one full-screen capture request; the host target is optional. */
export function parseScreenArgs(args: unknown): ScreenArgs {
  const value = asRecord(args, 'arguments');
  const result: ScreenArgs = {
    deviceId: requireString(value.deviceId, 'deviceId', 256),
  };
  const hostDeviceId = optionalString(value.hostDeviceId, 'hostDeviceId', 128);
  if (hostDeviceId !== undefined) result.hostDeviceId = hostDeviceId;
  return result;
}

export interface DeviceOperationArgs {
  action: 'list' | 'ensure_ready' | 'launch_host';
  deviceId?: string;
  hostDeviceId?: string;
  rebind: boolean;
  waitMs: number;
}

export function parseDeviceOperationArgs(args: unknown): DeviceOperationArgs {
  const value = asRecord(args, 'arguments');
  if (value.action !== 'list' && value.action !== 'ensure_ready' && value.action !== 'launch_host') {
    throw invalid('action must be list, ensure_ready, or launch_host');
  }
  const result: DeviceOperationArgs = {
    action: value.action,
    rebind: value.rebind === true,
    waitMs: boundedNumber(value.waitMs, 'waitMs', 30_000, 1_000, 90_000),
  };
  const deviceId = optionalString(value.deviceId, 'deviceId', 128);
  const hostDeviceId = optionalString(value.hostDeviceId, 'hostDeviceId', 128);
  if (deviceId !== undefined) result.deviceId = deviceId;
  if (hostDeviceId !== undefined) result.hostDeviceId = hostDeviceId;
  if (result.action === 'ensure_ready' && result.deviceId === undefined) {
    throw invalid('deviceId is required for ensure_ready');
  }
  if (result.action === 'list' && (result.deviceId !== undefined || result.hostDeviceId !== undefined)) {
    throw invalid('list does not accept deviceId or hostDeviceId');
  }
  return result;
}

/** Which selector a tap target carries. */
export interface AutomationTarget {
  testID?: string;
  label?: string;
  role?: string;
  alias?: string;
  path?: string;
}

/** Post-action expectation. */
/** One scoped post-action condition; text assertions read only this testID. */
export interface AutomationCheck {
  testID?: string;
  label?: string;
  textContains?: string;
  textEquals?: string;
  focused?: boolean;
}

/** Post-action expectation: legacy fields plus an ANDed list of scoped checks. */
export interface AutomationExpect extends AutomationCheck {
  visibleTestID?: string;
  visibleLabel?: string;
  checks?: AutomationCheck[];
}

export type AutomationAction = 'observe' | 'tap' | 'type' | 'scroll';

export interface AutomationArgs {
  action: AutomationAction;
  deviceId: string;
  opId: string;
  appId?: string;
  instanceId?: string;
  snapshotId?: string;
  diagnosticCursor?: number;
  timeoutMs: number;
  target?: AutomationTarget;
  expect?: AutomationExpect;
  text?: string;
  replace?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  includeFrames?: boolean;
  includeHidden?: boolean;
}

function parseTarget(value: unknown): AutomationTarget {
  const record = asRecord(value, 'target');
  const target: AutomationTarget = {};
  const testID = optionalString(record.testID, 'target.testID', 128);
  const label = optionalString(record.label, 'target.label', 128);
  const role = optionalString(record.role, 'target.role', 64);
  const alias = optionalString(record.alias, 'target.alias', 64);
  const path = optionalString(record.path, 'target.path', 256);
  if (testID !== undefined) target.testID = testID;
  if (label !== undefined) target.label = label;
  if (role !== undefined) target.role = role;
  if (alias !== undefined) target.alias = alias;
  if (path !== undefined) target.path = path;
  if (Object.keys(target).length === 0) throw invalid('target requires testID, label, role, alias, or path');
  return target;
}

function parseCheck(value: unknown, field: string): AutomationCheck {
  const record = asRecord(value, field);
  const check: AutomationCheck = {};
  for (const key of ['testID', 'label', 'textContains', 'textEquals'] as const) {
    const item = optionalString(record[key], `${field}.${key}`, 512);
    if (item !== undefined) check[key] = item;
  }
  if (record.focused !== undefined) {
    if (typeof record.focused !== 'boolean') throw invalid(`${field}.focused must be a boolean`);
    check.focused = record.focused;
  }
  if (Object.keys(check).length === 0) {
    throw invalid(`${field} requires testID, label, textContains, textEquals, or focused`);
  }
  return check;
}

function parseExpect(value: unknown): AutomationExpect | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, 'expect');
  const expect: AutomationExpect = {};
  for (const key of ['visibleTestID', 'visibleLabel', 'textContains', 'textEquals'] as const) {
    const item = optionalString(record[key], `expect.${key}`, 512);
    if (item !== undefined) expect[key] = item;
  }
  if (record.checks !== undefined) {
    if (!Array.isArray(record.checks) || record.checks.length === 0 || record.checks.length > 8) {
      throw invalid('expect.checks must be an array of 1 to 8 checks');
    }
    expect.checks = record.checks.map((entry, index) => parseCheck(entry, `expect.checks[${index}]`));
  }
  if (Object.keys(expect).length === 0) {
    throw invalid('expect requires visibleTestID, visibleLabel, textContains, textEquals, or checks');
  }
  return expect;
}

/**
 * Validate one automation request. `opId` is part of the bridge idempotency
 * contract, so the caller supplies it (tools generate one per call).
 */
export function parseAutomationArgs(action: AutomationAction, args: unknown): AutomationArgs {
  const value = asRecord(args, 'arguments');
  const result: AutomationArgs = {
    action,
    deviceId: requireString(value.deviceId, 'deviceId', 256),
    opId: requireString(value.opId, 'opId', 256),
    timeoutMs: boundedNumber(value.timeoutMs, 'timeoutMs', 15_000, 1_000, 30_000),
  };
  const appId = optionalString(value.appId, 'appId', 128);
  const instanceId = optionalString(value.instanceId, 'instanceId', 128);
  const snapshotId = optionalString(value.snapshotId, 'snapshotId', 128);
  if (appId !== undefined) result.appId = appId;
  if (instanceId !== undefined) result.instanceId = instanceId;
  if (snapshotId !== undefined) result.snapshotId = snapshotId;
  if (value.diagnosticCursor !== undefined) {
    result.diagnosticCursor = boundedNumber(value.diagnosticCursor, 'diagnosticCursor', 0, 0, Number.MAX_SAFE_INTEGER);
  }
  if (value.includeFrames !== undefined) {
    if (typeof value.includeFrames !== 'boolean') throw invalid('includeFrames must be a boolean');
    result.includeFrames = value.includeFrames;
  }
  if (value.includeHidden !== undefined) {
    if (typeof value.includeHidden !== 'boolean') throw invalid('includeHidden must be a boolean');
    result.includeHidden = value.includeHidden;
  }
  if (action === 'tap' || action === 'type' || action === 'scroll') {
    result.target = parseTarget(value.target);
    const expect = parseExpect(value.expect);
    if (expect !== undefined) result.expect = expect;
  }
  if (action === 'scroll') {
    if (value.direction !== undefined) {
      if (value.direction !== 'up' && value.direction !== 'down'
        && value.direction !== 'left' && value.direction !== 'right') {
        throw invalid('direction must be up, down, left, or right');
      }
      result.direction = value.direction;
    }
    if (value.amount !== undefined) {
      const amount = Number(value.amount);
      if (!Number.isFinite(amount)) throw invalid('amount must be a number');
      result.amount = Math.min(Math.max(amount, 0.1), 1);
    }
  }
  if (action === 'type') {
    if (typeof value.text !== 'string') throw invalid('type requires text');
    result.text = value.text.slice(0, 1024);
    if (value.replace !== undefined) {
      if (typeof value.replace !== 'boolean') throw invalid('replace must be a boolean');
      result.replace = value.replace;
    }
  }
  return result;
}

/* --------------------------------------------------------------- readings */

export function parsePairingCreateArgs(args: unknown): { ttlMs: number } {
  const value = args === undefined || args === null ? {} : asRecord(args, 'body');
  return { ttlMs: boundedNumber(value.ttlMs, 'ttlMs', DEFAULT_PAIRING_TTL_MS, MIN_PAIRING_TTL_MS, MAX_PAIRING_TTL_MS) };
}

/** Explicit setup request; consent is the only path to creating trust material. */
export interface SetupArgs {
  consent: true;
  host: '127.0.0.1' | '0.0.0.0';
  tls: boolean;
  nshPath: string | null;
}

export function parseSetupArgs(args: unknown): SetupArgs {
  const value = args === undefined || args === null ? {} : asRecord(args, 'body');
  if (value.consent !== true) {
    throw new JieZiError('consent_required', 'setup requires explicit consent: send { consent: true }');
  }
  const host = value.host === undefined ? '0.0.0.0' : value.host;
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new JieZiError('invalid_request', 'host must be 127.0.0.1 or 0.0.0.0');
  }
  if (value.tls !== undefined && typeof value.tls !== 'boolean') {
    throw new JieZiError('invalid_request', 'tls must be a boolean');
  }
  return {
    consent: true,
    host,
    tls: value.tls !== false,
    nshPath: value.nshPath === undefined || value.nshPath === null
      ? null
      : requireString(value.nshPath, 'nshPath', 4096),
  };
}

/** Read a bounded string field from a bridge object. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Read a string field or null. */
function textOrNull(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Map one bridge device record into the panel shape. */
export function deviceView(value: unknown): DeviceView {
  const record = asRecord(value, 'device');
  const active = record.activeApp === null || record.activeApp === undefined
    ? null
    : asRecord(record.activeApp, 'device.activeApp');
  const installed = active && Array.isArray(active.installedApps) ? active.installedApps : [];
  const activeApp: DeviceView['activeApp'] = active === null ? null : {
    appId: textOrNull(active.appId, 128),
    releaseId: textOrNull(active.releaseId, 128),
    instanceId: textOrNull(active.instanceId, 128),
    installedApps: installed.slice(0, MAX_INSTALLED_APPS).map((entry) => {
      const app = asRecord(entry, 'installedApp');
      return {
        appId: text(app.appId, 128),
        title: text(app.title, 128),
        releaseId: text(app.releaseId, 128),
        state: text(app.state, 32),
        active: bool(app.active),
      };
    }),
  };
  const revocation = record.revocation !== null && typeof record.revocation === 'object' && !Array.isArray(record.revocation)
    ? record.revocation as Record<string, unknown>
    : null;
  const hostVersion = textOrNull(record.hostVersion ?? record.appVersion, 64);
  return {
    deviceId: text(record.deviceId, 256),
    name: text(record.name, 128) || text(record.deviceName, 128) || 'iPhone',
    pairedAt: textOrNull(record.pairedAt, 64),
    lastSeenAt: textOrNull(record.lastSeenAt, 64),
    online: bool(record.online),
    jieziPaired: true,
    coreDevicePaired: typeof record.coreDevicePaired === 'boolean' ? record.coreDevicePaired : null,
    hostRunning: typeof record.hostRunning === 'boolean' ? record.hostRunning : bool(record.online),
    hostVersion,
    hostMinimumVersion: MIN_HOST_VERSION,
    hostCompatibility: hostCompatibility(hostVersion),
    boundHostDeviceId: textOrNull(record.boundHostDeviceId, 128),
    nextAction: textOrNull(record.nextAction, 500),
    targetKind: record.targetKind === 'physical' || record.targetKind === 'simulator' ? record.targetKind : null,
    revocation: revocation === null ? null : {
      developerMode: bool(revocation.developerMode),
      automation: bool(revocation.automation),
      updatedAt: textOrNull(revocation.updatedAt, 64),
    },
    developerMode: bool(record.developerMode),
    automation: bool(record.automation),
    activeApp,
  };
}

/** Map one bridge operation into the panel shape. */
export function deploymentView(value: unknown): DeploymentView {
  const record = asRecord(value, 'op');
  return {
    opId: text(record.opId, 256),
    deviceId: text(record.deviceId, 256),
    releaseId: text(record.releaseId, 256),
    state: text(record.state, 32) || 'pending',
    failureLayer: textOrNull(record.failureLayer, 32),
    evidenceId: textOrNull(record.evidenceId, 256),
    updatedAt: textOrNull(record.updatedAt, 64),
  };
}

/** Map one automation result into the bounded panel shape. */
export function automationView(value: unknown, fallback: {
  requestId: string;
  opId: string | null;
  deviceId: string;
  action: AutomationAction;
  appId?: string | null;
  instanceId?: string | null;
}): AutomationView {
  const record = asRecord(value, 'automation');
  const snapshot = record.snapshot === null || record.snapshot === undefined ? null : asRecord(record.snapshot, 'snapshot');
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const errorRecord = record.error === null || record.error === undefined ? null : asRecord(record.error, 'automation.error');
  return {
    requestId: text(record.requestId, 256) || fallback.requestId,
    opId: textOrNull(record.opId, 256) ?? fallback.opId,
    deviceId: text(record.deviceId, 256) || fallback.deviceId,
    action: record.action === 'tap' || record.action === 'type' || record.action === 'scroll' ? record.action : fallback.action,
    state: text(record.state, 32) || 'pending',
    appId: textOrNull(snapshot?.appId ?? record.appId, 128) ?? fallback.appId ?? null,
    instanceId: textOrNull(snapshot?.instanceId ?? record.instanceId, 128) ?? fallback.instanceId ?? null,
    nodeCount: nodes.length,
    error: errorRecord === null ? null : {
      code: text(errorRecord.code, 64),
      message: text(errorRecord.message, 500),
      ...(errorRecord.category === 'device' || errorRecord.category === 'host'
        || errorRecord.category === 'runtime' || errorRecord.category === 'verification'
        ? { category: errorRecord.category }
        : {}),
    },
    hostAlert: automationAlert(record.hostAlert),
    updatedAt: textOrNull(record.updatedAt, 64),
  };
}

/** Normalize the bridge's bounded Host-alert payload. */
export function automationAlert(value: unknown): AutomationAlert | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    code: text(record.code, 64) || 'HOST_ALERT',
    message: text(record.message, 1000),
    appId: textOrNull(record.appId, 128),
    releaseId: textOrNull(record.releaseId, 128),
    instanceId: textOrNull(record.instanceId, 128),
  };
}

/**
 * Check a post-action expectation against the fresh bounded snapshot.
 * Conditions are ANDed; only visible nodes participate. Legacy fields remain
 * for compatibility. `checks` evaluates several independently scoped
 * conditions, which is how one action asserts both a progress value and a hint
 * text. The bridge and device do not evaluate expectations, so this shared
 * layer is the single place both the panel and the Agent agree on pass/fail.
 */
export function evaluateExpectation(
  expect: AutomationExpect | undefined,
  snapshot: AutomationSnapshot | null,
): { passed: boolean; reason: string | null } {
  if (expect === undefined) return { passed: true, reason: null };
  if (snapshot === null) return { passed: false, reason: '动作后没有返回页面快照' };
  const visible = snapshot.nodes.filter((node) => node.visible);
  const failures: string[] = [];
  const contains = (node: SnapshotNode, text: string): boolean =>
    (node.label ?? '').includes(text) || (node.value ?? '').includes(text);
  const equals = (node: SnapshotNode, text: string): boolean =>
    node.label === text || node.value === text;

  if (expect.visibleTestID !== undefined
    && !visible.some((node) => node.testID === expect.visibleTestID)) {
    failures.push(`可见元素 testID=${expect.visibleTestID} 不存在`);
  }
  if (expect.visibleLabel !== undefined
    && !visible.some((node) => node.label === expect.visibleLabel)) {
    failures.push(`可见元素 label=${JSON.stringify(expect.visibleLabel)} 不存在`);
  }
  // Legacy text assertions scope to visibleTestID when present; otherwise any
  // visible node may satisfy them. This prevents a parent aggregate label
  // ("pressed 0 +1") from satisfying a check aimed at the count node ("0").
  const legacyScope = expect.visibleTestID === undefined
    ? visible
    : visible.filter((node) => node.testID === expect.visibleTestID);
  if (expect.textContains !== undefined
    && !legacyScope.some((node) => contains(node, expect.textContains as string))) {
    failures.push(`${expect.visibleTestID === undefined ? '没有可见文本' : `${expect.visibleTestID} 的文本不`}包含 ${JSON.stringify(expect.textContains)}`);
  }
  if (expect.textEquals !== undefined
    && !legacyScope.some((node) => equals(node, expect.textEquals as string))) {
    failures.push(`${expect.visibleTestID === undefined ? '没有可见文本' : `${expect.visibleTestID} 的文本不`}等于 ${JSON.stringify(expect.textEquals)}`);
  }

  for (const [index, check] of (expect.checks ?? []).entries()) {
    const label = `检查 ${index + 1}`;
    if (check.testID !== undefined && !visible.some((node) => node.testID === check.testID)) {
      failures.push(`${label}: 可见元素 testID=${check.testID} 不存在`);
    }
    if (check.label !== undefined && !visible.some((node) => node.label === check.label)) {
      failures.push(`${label}: 可见元素 label=${JSON.stringify(check.label)} 不存在`);
    }
    if (check.focused !== undefined) {
      const focused = visible.some((node) => node.focused);
      if (check.focused !== focused) {
        failures.push(`${label}: 焦点状态应为 ${check.focused ? '有' : '无'}`);
      }
    }
    const scope = check.testID !== undefined
      ? visible.filter((node) => node.testID === check.testID)
      : check.label !== undefined
        ? visible.filter((node) => node.label === check.label)
        : visible;
    if (check.textContains !== undefined && !scope.some((node) => contains(node, check.textContains as string))) {
      failures.push(`${label}: ${check.testID === undefined ? '没有可见文本' : `${check.testID} 的文本不`}包含 ${JSON.stringify(check.textContains)}`);
    }
    if (check.textEquals !== undefined && !scope.some((node) => equals(node, check.textEquals as string))) {
      failures.push(`${label}: ${check.testID === undefined ? '没有可见文本' : `${check.testID} 的文本不`}等于 ${JSON.stringify(check.textEquals)}`);
    }
  }

  return failures.length === 0
    ? { passed: true, reason: null }
    : { passed: false, reason: failures.join('；') };
}

/** Read the bounded semantic snapshot inside one automation result. */
export function automationSnapshot(value: unknown): AutomationSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const raw = snapshot as Record<string, unknown>;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, MAX_OUTLINE_NODES) : [];
  const mapped: SnapshotNode[] = nodes.map((entry) => {
    const node = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const frame = node.frame !== null && typeof node.frame === 'object' && !Array.isArray(node.frame)
      ? node.frame as Record<string, unknown>
      : null;
    return {
      alias: textOrNull(node.alias, 16),
      testID: textOrNull(node.testID, 256),
      label: textOrNull(node.label, 512),
      role: textOrNull(node.role, 64),
      value: textOrNull(node.value, 512),
      frame: frame === null ? null : {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(0, Number(frame.width) || 0),
        height: Math.max(0, Number(frame.height) || 0),
      },
      enabled: node.enabled !== false,
      visible: node.visible !== false,
      focused: node.focused === true,
      path: textOrNull(node.path, 256),
    };
  });
  // A recycled virtualized row can survive in the accessibility tree as a
  // hidden node with the same testID as a visible row. Drop that hidden
  // duplicate; never drop a visible duplicate, which is a real app bug.
  const visibleIDs = new Set(mapped.filter((node) => node.visible && node.testID !== null).map((node) => node.testID as string));
  const deduped = mapped.filter((node) => node.visible || node.testID === null || !visibleIDs.has(node.testID));
  const counts = new Map<string, number>();
  for (const node of deduped) {
    if (node.visible && node.testID !== null) counts.set(node.testID, (counts.get(node.testID) ?? 0) + 1);
  }
  const duplicateTestIDs = [...counts.entries()].filter(([, count]) => count > 1).map(([testID]) => testID).slice(0, 8);
  return {
    snapshotId: textOrNull(raw.snapshotId, 128),
    appId: textOrNull(raw.appId, 128),
    releaseId: textOrNull(raw.releaseId, 128),
    instanceId: textOrNull(raw.instanceId, 128),
    mode: text(raw.mode, 32) || 'semantic',
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.slice(0, 8).map((item) => text(item, 64)).filter(Boolean) : [],
    screen: raw.screen !== null && typeof raw.screen === 'object' && !Array.isArray(raw.screen)
      ? {
          width: Math.max(0, Number((raw.screen as Record<string, unknown>).width) || 0),
          height: Math.max(0, Number((raw.screen as Record<string, unknown>).height) || 0),
        }
      : null,
    nodes: deduped,
    truncated: raw.truncated === true || (Array.isArray(raw.nodes) && raw.nodes.length > nodes.length),
    visibleNodeCount: deduped.filter((node) => node.visible).length,
    hiddenNodeCount: deduped.filter((node) => !node.visible).length,
    duplicateTestIDs,
  };
}

export function automationDiagnostics(value: unknown): AutomationDiagnostics | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const cursor = Math.max(0, Math.trunc(Number(record.cursor) || 0));
  const sequences = Array.isArray(record.sequences)
    ? record.sequences.slice(0, 60).map((item) => Math.max(0, Math.trunc(Number(item) || 0)))
    : [];
  const events = Array.isArray(record.events)
    ? record.events.slice(-20).map((item) => {
        const event = item !== null && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {};
        return {
          sequence: Math.max(0, Math.trunc(Number(event.sequence) || 0)),
          level: text(event.level, 16),
          code: textOrNull(event.code, 100),
          message: text(event.message, 1000),
          timestamp: textOrNull(event.timestamp, 64),
        };
      })
    : [];
  return { cursor, sequences, events };
}

function quote(value: string | null, max = 60): string {
  if (value === null) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const clipped = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return JSON.stringify(clipped);
}

/**
 * Render a compact, bounded outline of one semantic snapshot. The line-per-node
 * form keeps a tool result small while preserving the selectors a follow-up tap
 * needs (alias, testID, label, role, path). Hidden nodes are omitted by default
 * because a virtualized list can leave recycled rows in the accessibility tree;
 * `visibleOnly: false` opts back in.
 */
export function formatOutline(
  snapshot: AutomationSnapshot,
  options: { frames?: boolean; visibleOnly?: boolean } = {},
): string {
  const visibleOnly = options.visibleOnly !== false;
  const nodes = visibleOnly ? snapshot.nodes.filter((node) => node.visible) : snapshot.nodes;
  const header = [
    `snapshot ${snapshot.snapshotId ?? '(none)'}`,
    `app=${snapshot.appId ?? '?'}`,
    `instance=${snapshot.instanceId ?? '?'}`,
    `mode=${snapshot.mode}`,
    options.frames === true && snapshot.screen != null
      ? `screen=${formatNumber(snapshot.screen.width)}x${formatNumber(snapshot.screen.height)}`
      : null,
    `nodes=${nodes.length}${visibleOnly && (snapshot.hiddenNodeCount ?? 0) > 0 ? ` (${snapshot.hiddenNodeCount} hidden omitted)` : ''}${snapshot.truncated ? ' (truncated)' : ''}`,
    (snapshot.duplicateTestIDs ?? []).length > 0
      ? `duplicateTestIDs=${(snapshot.duplicateTestIDs ?? []).map((item) => quote(item, 80)).join(',')}`
      : null,
  ].filter((item): item is string => item !== null).join(' ');
  const lines = [header];
  for (const [index, node] of nodes.entries()) {
    const parts: string[] = [`[${index}]`];
    if (node.alias) parts.push(`alias=${node.alias}`);
    if (node.testID) parts.push(`testID=${quote(node.testID, 80)}`);
    if (node.label) parts.push(`label=${quote(node.label, 80)}`);
    if (node.role) parts.push(`role=${node.role}`);
    if (options.frames === true && node.frame !== null) {
      parts.push(`frame=${formatNumber(node.frame.x)},${formatNumber(node.frame.y)} ${formatNumber(node.frame.width)}x${formatNumber(node.frame.height)}`);
    }
    if (node.role === 'textField' || node.role === 'textView' || node.role === 'searchField' || node.focused) {
      if (node.value) parts.push(`value=${quote(node.value, 80)}`);
    }
    if (node.focused) parts.push('focused');
    if (!node.visible) parts.push('hidden');
    if (!node.enabled) parts.push('disabled');
    if (node.path) parts.push(`path=${node.path}`);
    const line = parts.join(' ');
    if (lines.join('\n').length + line.length + 1 > MAX_OUTLINE_CHARS) {
      lines.push(`… ${nodes.length - index} more nodes omitted`);
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** One compact coordinate value: whole points stay whole, fractions keep one digit. */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/** Bound any rendered value for a tool result. */
export function truncateResult(value: unknown): unknown {
  const rendered = JSON.stringify(value);
  if (rendered === undefined || rendered.length <= MAX_TOOL_RESULT_CHARS) return value;
  return { ok: false, code: 'result_truncated', message: 'tool result exceeded the bounded size; narrow the request' };
}

/** Raise if a value is not one of the automation actions. */
export function requireAction(value: unknown): AutomationAction {
  if (value === 'observe' || value === 'tap' || value === 'type' || value === 'scroll') return value;
  throw new JieZiError('invalid_request', 'action must be observe, tap, type, or scroll');
}

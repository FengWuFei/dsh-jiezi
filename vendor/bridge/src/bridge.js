// The bridge: one HTTP server on a Unix socket for the DSH plugin, one
// loopback HTTP/WebSocket server for paired devices. It owns pairing, release
// metadata, operations, evidence, and the Agent wake-up event stream.

import { chmodSync, createReadStream, existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { buildProject, resolveNsh } from './build.js';
import { initializeProject } from './project-init.js';
import { VERSION } from './version.js';
import { createWsServer } from './ws.js';
import {
  MAX_MESSAGE_BYTES,
  ProtocolError,
  assertEnvelope,
  boundReport,
  canTransition,
  classifyFailure,
  envelope,
  equalHash,
  evidenceIdFor,
  hashToken,
  isState,
  opIdFor,
  sha256,
} from './protocol.js';

const MAX_BODY_BYTES = 1024 * 1024;
// A captureResult may carry a bounded screenshot (2 MiB decoded) plus its tree.
const MAX_DEVICE_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the directory one project call targets. The Host tools pass the DSH
 * Session working directory; the model never supplies a path, and the bridge's
 * configured project root remains the fallback for a call without one.
 */
export function resolveCallRoot(configuredRoot, requested) {
  const configured = realpathSync(configuredRoot);
  if (requested === undefined || requested === null) return configured;
  if (typeof requested !== 'string' || requested.length === 0 || !isAbsolute(requested)) {
    throw new ProtocolError('invalid_request', 'root must be a non-empty absolute path');
  }
  let real;
  try {
    real = realpathSync(requested);
  } catch {
    throw new ProtocolError('invalid_request', `root does not exist: ${requested}`);
  }
  if (!statSync(real).isDirectory()) throw new ProtocolError('invalid_request', 'root is not a directory');
  return real;
}

/** Accepted layouts for where `miniapp_init` places a new project. */
export const PROJECT_LAYOUTS = ['working-directory', 'named-subdirectory'];

/** Validate the caller's layout, defaulting to the working directory itself. */
export function resolveProjectLayout(value) {
  if (value === undefined || value === null) return 'working-directory';
  if (typeof value !== 'string' || !PROJECT_LAYOUTS.includes(value)) {
    throw new ProtocolError('invalid_request', `layout must be one of ${PROJECT_LAYOUTS.join(', ')}`);
  }
  return value;
}

/**
 * The exact directory `miniapp_init` scaffolds into. A call without a Session
 * root, or the named layout, keeps `<root>/<projectId>`.
 */
export function initDestination(root, layout, projectId, hasSessionRoot) {
  return !hasSessionRoot || layout === 'named-subdirectory' ? join(root, projectId) : root;
}

export class Bridge {
  constructor({ store, config, log = () => {} }) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.devices = new Map(); // deviceId -> { connection, lastSeenAt, presence }
    this.pairingSessions = new Map(); // sessionId -> short-lived pairing state
    this.automationRequests = new Map(); // requestId -> bounded operation state
    this.automationByOp = new Map(); // opId -> requestId
    this.openRequests = new Map(); // requestId -> bounded open-app state
    this.eventClients = new Set();
    this.startedAt = new Date().toISOString();
    this.controlServer = null;
    this.deviceServer = null;
    this.controlAddress = null;
    this.deviceAddress = null;
    this.ws = null;
    this.closeRequested = false;
  }

  async start() {
    resolveNsh(this.config.nshPath);
    await prepareSocket(this.config.socketPath);
    const self = this;

    this.controlServer = createHttpServer((req, res) => {
      self.handleControl(req, res).catch((error) => {
        self.respondError(res, error);
      });
    });
    await listen(this.controlServer, { path: this.config.socketPath });
    chmodSync(this.config.socketPath, 0o600);
    this.controlAddress = { socketPath: this.config.socketPath };

    const deviceHandler = (req, res) => {
      self.handleDeviceHttp(req, res).catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'internal' } }));
      });
    };
    this.deviceServer = this.config.tlsCert && this.config.tlsKey
      ? createHttpsServer({
          cert: readFileSync(this.config.tlsCert),
          key: readFileSync(this.config.tlsKey),
        }, deviceHandler)
      : createHttpServer(deviceHandler);
    await listen(this.deviceServer, {
      host: this.config.host,
      port: this.config.port,
    });
    this.deviceAddress = this.deviceServer.address();
    this.ws = createWsServer({
      server: this.deviceServer,
      path: '/device',
      maxPayload: MAX_DEVICE_MESSAGE_BYTES,
      onConnection: (connection, auth) => self.handleDeviceConnection(connection, auth),
    });
    return this.describe();
  }

  describe() {
    return {
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      socket: this.config.socketPath,
      deviceUrl: this.advertisedDeviceUrl(),
      artifactBase: this.config.publicUrlBase ?? this.advertisedBaseUrl(),
      tlsFingerprint: this.config.tlsFingerprint ?? null,
      projectRoot: this.config.projectRoot,
      nsh: this.config.nshPath,
      requireSigned: this.config.requireSigned,
      devices: this.store.listDevices().length,
      capabilities: ['project-init', 'deploy', 'evidence', 'capture', 'pairing-session', 'automation'],
    };
  }

  listDevices() {
    return this.store.listDevices().map((device) => {
      const live = this.devices.get(device.deviceId);
      const presence = live?.presence ?? null;
      return {
        ...device,
        targetKind: live?.presence?.targetKind ?? device.targetKind ?? null,
        online: Boolean(live),
        developerMode: Boolean(presence?.developerMode),
        automation: Boolean(presence?.automation),
        activeApp: presence
          ? {
              appId: presence.appId ?? null,
              releaseId: presence.releaseId ?? null,
              instanceId: presence.instanceId ?? null,
              installedApps: presence.installedApps ?? [],
            }
          : null,
        lastSeenAt: live?.lastSeenAt ?? device.lastSeenAt ?? null,
      };
    });
  }

  async stop() {
    this.closeRequested = true;
    this.ws?.closeAll();
    for (const client of this.eventClients) {
      try {
        client.end();
      } catch {
        // Ignore a closed SSE client.
      }
    }
    this.eventClients.clear();
    await Promise.all([closeServer(this.controlServer), closeServer(this.deviceServer)]);
    try {
      if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
    } catch {
      // Socket cleanup is best effort.
    }
  }

  // ---------------------------------------------------------------- control

  async handleControl(req, res) {
    const url = new URL(req.url ?? '/', 'http://unix');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/v1/health') {
      return sendJson(res, 200, this.describe());
    }
    if (req.method === 'GET' && path === '/v1/events') {
      return this.openEvents(req, res);
    }
    if (req.method === 'GET' && path === '/v1/devices') {
      return sendJson(res, 200, { ok: true, devices: this.listDevices() });
    }
    if (req.method === 'POST' && path === '/v1/unpair') {
      const body = await readBody(req);
      return sendJson(res, 200, this.unpair(body));
    }
    if (req.method === 'POST' && path === '/v1/pairing-sessions') {
      const body = await readBody(req);
      return sendJson(res, 200, this.createPairingSession(body));
    }
    const pairingMatch = path.match(/^\/v1\/pairing-sessions\/([^/]+)$/);
    if (req.method === 'GET' && pairingMatch) {
      return sendJson(res, 200, this.pairingSessionStatus(decodeURIComponent(pairingMatch[1])));
    }
    if (req.method === 'POST' && path === '/v1/automation') {
      const body = await readBody(req);
      return sendJson(res, 200, this.startAutomation(body));
    }
    const automationMatch = path.match(/^\/v1\/automation\/([^/]+)$/);
    if (req.method === 'GET' && automationMatch) {
      return sendJson(res, 200, this.automationStatus(decodeURIComponent(automationMatch[1])));
    }
    if (req.method === 'POST' && path === '/v1/open') {
      const body = await readBody(req);
      return sendJson(res, 200, this.startOpen(body));
    }
    const openMatch = path.match(/^\/v1\/open\/([^/]+)$/);
    if (req.method === 'GET' && openMatch) {
      return sendJson(res, 200, this.openStatus(decodeURIComponent(openMatch[1])));
    }
    if (req.method === 'GET' && path === '/v1/ops') {
      const deviceId = url.searchParams.get('deviceId') ?? undefined;
      return sendJson(res, 200, {
        ok: true,
        ops: this.store.listOps(deviceId).slice(0, 50).map(publicOp),
      });
    }
    const opMatch = path.match(/^\/v1\/ops\/([^/]+)$/);
    if (req.method === 'GET' && opMatch) {
      const op = this.store.getOp(decodeURIComponent(opMatch[1]));
      if (!op) throw new ProtocolError('unknown_op', 'no operation with that id');
      return sendJson(res, 200, { ok: true, op: publicOp(op) });
    }
    const evidenceMatch = path.match(/^\/v1\/evidence\/([^/]+)$/);
    if (req.method === 'GET' && evidenceMatch) {
      const record = this.store.getEvidence(decodeURIComponent(evidenceMatch[1]));
      if (!record) throw new ProtocolError('unknown_evidence', 'no evidence with that id');
      const includeReport = url.searchParams.get('include') === 'report';
      return sendJson(res, 200, {
        ok: true,
        evidenceId: record.evidenceId,
        releaseId: record.releaseId,
        opId: record.opId,
        sessionId: record.sessionId,
        failureLayer: record.failureLayer,
        summary: record.summary,
        counts: record.counts,
        truncated: record.truncated,
        droppedEvents: record.droppedEvents,
        path: record.path,
        receivedAt: record.receivedAt,
        ...(includeReport ? { report: record.report } : {}),
      });
    }
    const captureMatch = path.match(/^\/v1\/captures\/([^/]+)$/);
    if (req.method === 'GET' && captureMatch) {
      const capture = this.store.getCapture(decodeURIComponent(captureMatch[1]));
      if (!capture) throw new ProtocolError('invalid_request', 'unknown capture request');
      return sendJson(res, 200, { ok: true, capture: publicCapture(capture) });
    }
    if (req.method === 'POST' && path === '/v1/projects/init') {
      const body = await readBody(req);
      return sendJson(res, 200, await this.initProject(body));
    }
    if (req.method === 'POST' && path === '/v1/build') {
      const body = await readBody(req);
      return sendJson(res, 200, await this.build(body));
    }
    if (req.method === 'POST' && path === '/v1/deploy') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await this.deploy(body)) });
    }
    if (req.method === 'POST' && path === '/v1/capture') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, ...this.capture(body) });
    }
    throw new ProtocolError('invalid_request', `unknown route: ${req.method} ${path}`);
  }

  async initProject(body) {
    const projectId = requireId(body.projectId, 'projectId');
    const root = resolveCallRoot(this.config.projectRoot, body.root);
    const layout = resolveProjectLayout(body.layout);
    const destination = initDestination(root, layout, projectId, body.root !== undefined);
    const result = await initializeProject({
      body,
      destination,
      nshPath: resolveNsh(this.config.nshPath),
    });
    this.log(`init ${result.projectId} ${result.projectDir}`);
    return result;
  }

  async build(body) {
    const projectId = requireId(body.projectId, 'projectId');
    const projectRoot = resolveCallRoot(this.config.projectRoot);
    const callRoot = resolveCallRoot(this.config.projectRoot, body.root);
    const layout = resolveProjectLayout(body.layout);
    const roots = new Set([projectRoot, callRoot]);
    const requested = body.projectDir
      ? resolve(String(body.projectDir))
      : body.root !== undefined && layout === 'working-directory' ? callRoot : join(callRoot, projectId);
    let projectDir;
    try {
      projectDir = realpathSync(requested);
    } catch {
      throw new ProtocolError('invalid_request', `project directory does not exist: ${requested}`);
    }
    if (![...roots].some((root) => projectDir === root || projectDir.startsWith(`${root}${sep}`))) {
      throw new ProtocolError('outside_project_root', 'project directory is outside the configured root and the session root');
    }
    if (!statSync(projectDir).isDirectory()) {
      throw new ProtocolError('invalid_request', 'project path is not a directory');
    }

    this.log(`build ${projectId} ${projectDir}`);
    const buildNumber = this.store.reserveBuild(projectId);
    const nsh = resolveNsh(this.config.nshPath);
    const result = await buildProject({
      projectDir,
      projectId,
      nshPath: nsh,
      keyDir: this.config.devKeyDir,
      artifactDir: this.store.paths.artifacts,
      buildNumber,
      minRuntime: this.config.minRuntime,
      requireSigned: this.config.requireSigned,
    });
    if (!result.ok) {
      this.emit({ type: 'build', projectId, releaseId: result.releaseId, ok: false, stage: result.stage });
      return result;
    }
    this.store.recordRelease(projectId, {
      releaseId: result.releaseId,
      build: result.build,
      sha256: result.sha256,
      signed: result.signed,
      minRuntime: result.minRuntime ?? null,
      artifactPath: result.artifactPath,
      createdAt: new Date().toISOString(),
    });
    this.emit({ type: 'build', projectId, releaseId: result.releaseId, ok: true, build: result.build });
    return result;
  }

  // ------------------------------------------------------ pairing sessions

  createPairingSession(body = {}) {
    const requested = Number(body.ttlMs ?? 120_000);
    const ttlMs = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 30_000), 10 * 60_000) : 120_000;
    this.prunePairingSessions();
    const sessionId = `pair_${randomBytes(12).toString('hex')}`;
    const code = randomCode();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const endpoint = this.advertisedDeviceUrl();
    this.pairingSessions.set(sessionId, {
      sessionId,
      code,
      expiresAt,
      state: 'waiting',
      deviceId: null,
      createdAt: new Date().toISOString(),
    });
    return {
      ok: true,
      pairing: {
        sessionId,
        code,
        endpoint,
        certificateFingerprint: this.config.tlsFingerprint ?? null,
        expiresAt,
        bridgeName: hostname(),
      },
    };
  }

  pairingSessionStatus(sessionId) {
    this.prunePairingSessions();
    const session = this.pairingSessions.get(requireId(sessionId, 'sessionId'));
    if (!session) throw new ProtocolError('unknown_pairing_session', 'unknown pairing session');
    return {
      ok: true,
      pairing: {
        sessionId: session.sessionId,
        state: session.state,
        expiresAt: session.expiresAt,
        deviceId: session.deviceId,
      },
    };
  }

  consumePairingSession(sessionId, code) {
    this.prunePairingSessions();
    const id = requireId(sessionId, 'sessionId');
    const session = this.pairingSessions.get(id);
    if (!session) throw new ProtocolError('unknown_pairing_session', 'unknown pairing session');
    if (session.state !== 'waiting') throw new ProtocolError('pairing_used', 'pairing session is no longer waiting');
    if (Date.parse(session.expiresAt) < Date.now()) {
      session.state = 'expired';
      throw new ProtocolError('pairing_expired', 'pairing session expired');
    }
    if (session.code !== String(code)) throw new ProtocolError('pairing_mismatch', 'pairing code did not match');
    // One-use is enforced by the immediate state change in the caller; a failed
    // device save leaves it waiting for a retry with the same live code.
  }

  prunePairingSessions() {
    const now = Date.now();
    for (const session of this.pairingSessions.values()) {
      if (session.state === 'waiting' && Date.parse(session.expiresAt) < now) session.state = 'expired';
    }
  }

  advertisedDeviceUrl() {
    const secure = Boolean(this.config.tlsCert && this.config.tlsKey);
    return `${secure ? 'wss' : 'ws'}://${this.advertisedHost()}:${this.deviceAddress.port}/device`;
  }

  advertisedBaseUrl() {
    const secure = Boolean(this.config.tlsCert && this.config.tlsKey);
    return `${secure ? 'https' : 'http'}://${this.advertisedHost()}:${this.deviceAddress.port}`;
  }

  advertisedHost() {
    return this.config.host === '0.0.0.0' || this.config.host === '::'
      ? firstLanAddress()
      : this.config.host;
  }

  // ---------------------------------------------------------- automation

  startAutomation(body) {
    const deviceId = requireId(body.deviceId, 'deviceId');
    const opId = requireId(body.opId, 'opId');
    const action = String(body.action ?? '');
    if (!['observe', 'tap', 'type', 'scroll'].includes(action)) {
      throw new ProtocolError('invalid_request', 'action must be observe, tap, type, or scroll');
    }
    const device = this.store.getDevice(deviceId);
    if (!device) throw new ProtocolError('not_paired', 'unknown device');
    const live = this.devices.get(deviceId);
    if (!live) throw new ProtocolError('device_offline', 'device is not connected');

    const target = normalizeTarget(body.target, action);
    const expect = normalizeExpect(body.expect);
    let text = null;
    let replace = false;
    let direction = null;
    let amount = 0;
    if (action === 'type') {
      if (typeof body.text !== 'string') {
        throw new ProtocolError('invalid_request', 'type requires a text string');
      }
      text = safeText(body.text, 1024);
      replace = body.replace !== false;
    }
    if (action === 'scroll') {
      direction = body.direction === undefined ? 'down' : String(body.direction);
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new ProtocolError('invalid_request', 'scroll direction must be up, down, left, or right');
      }
      const raw = Number(body.amount);
      amount = Number.isFinite(raw) ? Math.min(Math.max(raw, 0.1), 1) : 0.8;
    }
    const appId = body.appId === undefined ? null : requireId(body.appId, 'appId');
    const instanceId = body.instanceId === undefined ? null : requireId(body.instanceId, 'instanceId');
    const snapshotId = body.snapshotId === undefined ? null : requireId(body.snapshotId, 'snapshotId');
    const diagnosticCursor = body.diagnosticCursor === undefined
      ? null
      : Math.max(0, Math.trunc(Number(body.diagnosticCursor) || 0));
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 15_000, 1_000), 30_000);
    const normalized = { action, target, expect, text, replace, direction, amount, appId, instanceId, snapshotId, diagnosticCursor, timeoutMs };
    const fingerprint = sha256(JSON.stringify(normalized));
    const existingId = this.automationByOp.get(opId);
    if (existingId) {
      const existing = this.automationRequests.get(existingId);
      if (existing && existing.deviceId === deviceId && existing.fingerprint === fingerprint) {
        this.refreshAutomation(existing);
        return { ok: true, request: publicAutomation(existing), deduplicated: true };
      }
      throw new ProtocolError('op_conflict', 'opId was already used for a different automation request');
    }

    const presence = live.presence;
    if (!presence?.automation) {
      throw new ProtocolError('automation_unavailable', 'device has not enabled developer automation');
    }
    // Presence can lag a just-completed deploy, so use presence only to reject
    // an explicitly supplied stale identity. Never echo presence back as the
    // expected identity when the caller omitted it; the device then observes
    // its current screen instead of a pre-deploy instance.
    if (appId && presence.appId && appId !== presence.appId) {
      throw new ProtocolError('app_not_active', 'requested app is not the active mini-app');
    }
    if (instanceId && presence.instanceId && instanceId !== presence.instanceId) {
      throw new ProtocolError('stale_instance', 'requested mini-app instance is no longer active');
    }
    const requestId = `auto_${randomBytes(10).toString('hex')}`;
    const request = {
      requestId,
      opId,
      deviceId,
      fingerprint,
      state: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: Date.now() + timeoutMs,
      timeoutMs,
      snapshot: null,
      error: null,
      action,
      appId: appId ?? null,
      instanceId: instanceId ?? null,
    };
    this.automationRequests.set(requestId, request);
    this.automationByOp.set(opId, requestId);
    const sent = live.connection.send(envelope('automationRequest', {
      requestId,
      opId,
      action,
      target,
      expect,
      text,
      replace,
      direction,
      amount,
      snapshotId,
      diagnosticCursor,
      timeoutMs,
      appId: request.appId,
      instanceId: request.instanceId,
    }));
    if (!sent) {
      request.state = 'failed';
      request.error = { code: 'device_offline', message: 'device connection closed before the request was sent' };
      request.updatedAt = new Date().toISOString();
    }
    return { ok: true, request: publicAutomation(request), deduplicated: false };
  }

  // ---------------------------------------------------------- open app

  /** Ask the Host to open one already installed app; no artifact is sent. */
  startOpen(body) {
    const deviceId = requireId(body.deviceId, 'deviceId');
    const appId = requireId(body.appId, 'appId');
    const device = this.store.getDevice(deviceId);
    if (!device) throw new ProtocolError('not_paired', 'unknown device');
    const live = this.devices.get(deviceId);
    if (!live) throw new ProtocolError('device_offline', 'device is not connected');
    if (!live.presence?.developerMode) {
      throw new ProtocolError('open_unavailable', 'device has not enabled developer mode');
    }
    const requestId = `open_${randomBytes(10).toString('hex')}`;
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 15_000, 1_000), 30_000);
    const request = {
      requestId,
      deviceId,
      appId,
      state: 'pending',
      instanceId: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deadline: Date.now() + timeoutMs,
    };
    this.openRequests.set(requestId, request);
    const sent = live.connection.send(envelope('openAppRequest', { requestId, appId, timeoutMs }));
    if (!sent) {
      request.state = 'failed';
      request.error = { code: 'device_offline', message: 'device connection closed before the request was sent' };
      request.updatedAt = new Date().toISOString();
    }
    return { ok: true, request: publicOpen(request) };
  }

  openStatus(requestId) {
    const request = this.openRequests.get(requireId(requestId, 'requestId'));
    if (!request) throw new ProtocolError('unknown_open', 'unknown open request');
    if (request.state === 'pending' && Date.now() > request.deadline) {
      request.state = 'failed';
      request.error = { code: 'OPEN_TIMEOUT', message: 'the device did not report a running instance in time' };
      request.updatedAt = new Date().toISOString();
    }
    return { ok: true, request: publicOpen(request) };
  }

  acceptOpenResult(device, payload) {
    const requestId = requireId(payload.requestId, 'requestId');
    const request = this.openRequests.get(requestId);
    if (!request || request.deviceId !== device.deviceId) {
      throw new ProtocolError('unknown_open', 'unknown open request for this device');
    }
    if (request.state !== 'pending') return;
    const state = String(payload.state ?? '');
    if (state !== 'done' && state !== 'failed') {
      throw new ProtocolError('invalid_request', `invalid open state: ${state}`);
    }
    request.state = state;
    request.updatedAt = new Date().toISOString();
    if (payload.instanceId !== undefined) {
      request.instanceId = safeText(payload.instanceId, 128) || null;
    }
    request.error = payload.error ? sanitizeError(payload.error) : null;
    if (state === 'done' && !request.instanceId) {
      request.state = 'failed';
      request.error = { code: 'invalid_request', message: 'the device reported done without an instance id' };
    }
  }

  automationStatus(requestId) {
    const request = this.automationRequests.get(requireId(requestId, 'requestId'));
    if (!request) throw new ProtocolError('unknown_automation', 'unknown automation request');
    this.refreshAutomation(request);
    return { ok: true, request: publicAutomation(request) };
  }

  refreshAutomation(request) {
    if (request.state === 'pending' && Date.now() >= request.deadline) {
      request.state = 'timeout';
      request.error = { code: 'timeout', message: 'the device did not answer before the deadline' };
      request.updatedAt = new Date().toISOString();
      this.emit({ type: 'automation', requestId: request.requestId, opId: request.opId, state: request.state });
    }
  }

  acceptAutomationResult(device, payload) {
    const requestId = requireId(payload.requestId, 'requestId');
    const opId = requireId(payload.opId, 'opId');
    const request = this.automationRequests.get(requestId);
    if (!request || request.deviceId !== device.deviceId) {
      throw new ProtocolError('unknown_automation', 'unknown automation request for this device');
    }
    if (request.opId !== opId) throw new ProtocolError('invalid_request', 'automation result opId mismatch');
    if (request.state !== 'pending') return;
    const state = String(payload.state ?? '');
    if (!['done', 'failed', 'unsupported', 'timeout'].includes(state)) {
      throw new ProtocolError('invalid_request', `invalid automation state: ${state}`);
    }
    request.state = state;
    request.updatedAt = new Date().toISOString();
    request.error = payload.error ? sanitizeError(payload.error) : null;
    if (payload.snapshot !== undefined) request.snapshot = boundAutomationSnapshot(payload.snapshot);
    if (payload.diagnostics !== undefined) request.diagnostics = boundAutomationDiagnostics(payload.diagnostics);
    if (payload.hostAlert !== undefined) request.hostAlert = boundHostAlert(payload.hostAlert);
    if (state === 'done' && !request.snapshot && request.action !== 'observe') {
      request.state = 'failed';
      request.error = { code: 'missing_snapshot', message: 'the device reported done without a post-action snapshot' };
    }
    this.emit({ type: 'automation', requestId, opId, state: request.state, deviceId: device.deviceId });
  }

  async deploy(body) {
    const deviceId = requireId(body.deviceId, 'deviceId');
    const releaseId = requireId(body.releaseId, 'releaseId');
    const device = this.store.getDevice(deviceId);
    if (!device) throw new ProtocolError('not_paired', 'unknown device');

    const release = this.releaseRecord(releaseId);
    if (!release) throw new ProtocolError('unknown_release', 'unknown release');
    if (!release.signed) {
      throw new ProtocolError('refused', 'release is unsigned; signed artifacts are required for delivery');
    }

    const opId = opIdFor(releaseId, deviceId);
    const existing = this.store.getOp(opId);
    if (existing) {
      const resent = existing.state === 'pending' ? this.sendDeploy(deviceId, existing) : false;
      return { opId, state: existing.state, deduplicated: true, resent };
    }

    const now = new Date().toISOString();
    const op = {
      opId,
      deviceId,
      releaseId,
      projectId: release.projectId ?? body.projectId ?? 'unknown',
      build: release.build,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      failureLayer: null,
      error: null,
      evidenceId: null,
    };
    this.store.saveOp(op);
    this.emit({ type: 'status', opId, state: op.state });
    const sent = this.sendDeploy(deviceId, op);
    return { opId, state: op.state, deduplicated: false, sent };
  }

  unpair(body) {
    const deviceId = requireId(body.deviceId, 'deviceId');
    const device = this.store.getDevice(deviceId);
    if (!device) throw new ProtocolError('not_paired', 'unknown device');
    const live = this.devices.get(deviceId);
    if (live) {
      live.connection.close(4009, 'unpaired');
      this.devices.delete(deviceId);
    }
    this.store.deleteDevice(deviceId);
    this.emit({ type: 'device', deviceId, state: 'unpaired' });
    return { ok: true, deviceId };
  }

  releaseRecord(releaseId) {
    const metaPath = join(this.store.paths.artifacts, `${releaseId}.nshpkg.json`);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      return null;
    }
  }

  sendDeploy(deviceId, op) {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    const release = this.releaseRecord(op.releaseId) ?? {};
    const artifactUrl = `${this.config.publicUrlBase ?? this.advertisedBaseUrl()}/artifacts/${encodeURIComponent(op.releaseId)}`;
    const sent = device.connection.send(envelope('deploy', {
      opId: op.opId,
      projectId: op.projectId,
      appId: release.appId ?? null,
      releaseId: op.releaseId,
      build: op.build,
      url: artifactUrl,
      sha256: release.sha256 ?? null,
      minRuntime: release.minRuntime ?? this.config.minRuntime ?? null,
      notes: 'JieZi P0 delivery',
    }));
    if (sent) {
      op.attempts += 1;
      op.updatedAt = new Date().toISOString();
      this.store.saveOp(op);
    }
    return sent;
  }

  capture(body) {
    const deviceId = requireId(body.deviceId, 'deviceId');
    const device = this.devices.get(deviceId);
    if (!device) throw new ProtocolError('device_offline', 'device is not connected');
    const requestId = `cap_${randomBytes(8).toString('hex')}`;
    const capture = {
      requestId,
      deviceId,
      state: 'pending',
      createdAt: new Date().toISOString(),
      result: null,
    };
    this.store.saveCapture(capture);
    device.connection.send(envelope('capture', { requestId }));
    return { requestId, state: 'pending' };
  }

  // ------------------------------------------------------------- device I/O

  handleDeviceConnection(connection, { token }) {
    if (!token) {
      this.acceptPairing(connection);
      return;
    }
    const device = this.findDeviceByToken(token);
    if (!device) {
      connection.close(4001, 'unknown device token');
      return;
    }
    this.store.touchDevice(device.deviceId);
    this.devices.set(device.deviceId, {
      connection,
      lastSeenAt: new Date().toISOString(),
      presence: null,
    });
    connection.onClose((code) => {
      const current = this.devices.get(device.deviceId);
      if (current?.connection === connection) this.devices.delete(device.deviceId);
      if (code === 4007) {
        this.store.setDeviceRevocation(device.deviceId, { developerMode: true, automation: true });
      }
      this.emit({ type: 'device', deviceId: device.deviceId, state: 'offline' });
    });
    connection.onMessage((raw) => {
      try {
        const payload = assertEnvelope(raw);
        this.handleDeviceMessage(device, raw.type, payload);
      } catch (error) {
        this.log(`device message rejected: ${error.message}`);
        connection.send(envelope('error', {
          code: error.code ?? 'invalid_request',
          message: error.message,
        }));
      }
    });
    connection.send(envelope('hello', {
      bridgeVersion: VERSION,
      projects: [],
      capabilities: ['deploy', 'evidence', 'capture', 'automation'],
    }));
    this.emit({ type: 'device', deviceId: device.deviceId, state: 'online' });
    for (const op of this.store.listOps(device.deviceId)) {
      if (op.state === 'pending') this.sendDeploy(device.deviceId, op);
    }
  }

  acceptPairing(connection) {
    const timer = setTimeout(() => connection.close(4008, 'pairing timeout'), 60_000);
    timer.unref?.();
    connection.onClose(() => clearTimeout(timer));
    connection.onMessage((raw) => {
      try {
        const payload = assertEnvelope(raw);
        if (raw.type !== 'pair') {
          connection.send(envelope('error', { code: 'not_paired', message: 'pair first' }));
          return;
        }
        const code = String(payload.code ?? '');
        const name = String(payload.deviceName ?? '').slice(0, 100);
        const publicKey = String(payload.publicKey ?? '').slice(0, 4096);
        const sessionId = payload.sessionId === undefined ? null : String(payload.sessionId);
        if (!name || !publicKey) throw new ProtocolError('invalid_request', 'deviceName and publicKey are required');
        if (sessionId) this.consumePairingSession(sessionId, code);
        else {
          const consumed = this.store.consumePairCode(code);
          if (!consumed.ok) {
            connection.send(envelope('pairError', { message: consumed.reason }));
            return;
          }
        }
        // A device key is the stable identity across re-pairing. Reuse its
        // device record instead of minting a new id, and remove stale duplicate
        // records with the same key. Pairing remains a one-time device action.
        const existing = this.findDeviceByPublicKey(publicKey);
        const deviceId = existing?.deviceId ?? `dev_${randomBytes(8).toString('hex')}`;
        const token = randomBytes(32).toString('base64url');
        for (const record of Object.values(this.store.deviceRecords())) {
          if (record.deviceId !== deviceId && record.publicKey === publicKey) {
            const duplicateLive = this.devices.get(record.deviceId);
            if (duplicateLive) {
              duplicateLive.connection.close(4009, 'superseded by re-pairing');
              this.devices.delete(record.deviceId);
            }
            this.store.deleteDevice(record.deviceId);
          }
        }
        const live = this.devices.get(deviceId);
        if (live) {
          live.connection.close(4009, 're-paired');
          this.devices.delete(deviceId);
        }
        this.store.saveDevice({
          deviceId,
          deviceName: name,
          targetKind: safeTargetKind(payload.targetKind),
          revocation: null,
          publicKey,
          tokenHash: hashToken(token),
          tokenPrefix: sha256(token).slice(0, 8),
          pairedAt: existing?.pairedAt ?? new Date().toISOString(),
          lastSeenAt: existing?.lastSeenAt ?? null,
        });
        if (sessionId) {
          const session = this.pairingSessions.get(sessionId);
          if (session) {
            session.state = 'paired';
            session.deviceId = deviceId;
            session.pairedAt = new Date().toISOString();
          }
        }
        const rootPublicKey = this.rootPublicKey();
        connection.send(envelope('paired', {
          deviceId,
          deviceToken: token,
          ...(rootPublicKey
            ? { rootPublicKey: rootPublicKey.key, rootKeyID: rootPublicKey.id }
            : {}),
        }));
        connection.close(1000, 'paired');
        this.emit({ type: 'device', deviceId, state: 'paired' });
      } catch (error) {
        connection.send(envelope('pairError', { message: error.message }));
      }
    });
  }

  rootPublicKey() {
    if (this.config.shareRootPublicKey === false || !this.config.devKeyDir) return null;
    try {
      const key = readFileSync(join(this.config.devKeyDir, 'root.pub'), 'utf8').trim();
      const bytes = Buffer.from(key, 'base64');
      if (bytes.length !== 32) return null;
      const id = sha256(bytes).slice(0, 16);
      return { key, id };
    } catch {
      return null;
    }
  }

  findDeviceByPublicKey(publicKey) {
    const matches = Object.values(this.store.deviceRecords())
      .filter((device) => typeof device.publicKey === 'string' && device.publicKey === publicKey)
      .sort((a, b) => String(b.pairedAt ?? '').localeCompare(String(a.pairedAt ?? '')));
    return matches[0] ?? null;
  }

  findDeviceByToken(token) {
    const hash = hashToken(token);
    for (const device of Object.values(this.store.deviceRecords())) {
      if (typeof device.tokenHash === 'string' && equalHash(device.tokenHash, hash)) return device;
    }
    return null;
  }

  handleDeviceMessage(device, type, payload) {
    if (type === 'ready') return this.acceptReady(device, payload);
    if (type === 'status') return this.updateStatus(device, payload);
    if (type === 'evidence') return this.acceptEvidence(device, payload);
    if (type === 'captureResult') return this.acceptCaptureResult(device, payload);
    if (type === 'screenshot') return this.acceptScreenshot(device, payload);
    if (type === 'automationResult') return this.acceptAutomationResult(device, payload);
    if (type === 'openAppResult') return this.acceptOpenResult(device, payload);
    throw new ProtocolError('invalid_request', `unsupported device message: ${type}`);
  }

  acceptReady(device, payload) {
    const live = this.devices.get(device.deviceId);
    if (!live) return;
    const installedApps = Array.isArray(payload.installedApps)
      ? payload.installedApps.slice(0, 50).map((app) => ({
          appId: safeText(app?.appId, 128),
          title: safeText(app?.title, 200),
          releaseId: safeText(app?.releaseId, 128),
          state: safeText(app?.state, 32),
          active: app?.active === true,
        }))
      : [];
    live.presence = {
      deviceName: safeText(payload.deviceName, 100),
      targetKind: safeTargetKind(payload.targetKind) ?? device.targetKind ?? null,
      appVersion: safeText(payload.appVersion, 64),
      developerMode: payload.developerMode === true,
      automation: payload.automation === true,
      appId: safeText(payload.appId, 128) || null,
      releaseId: safeText(payload.releaseId, 128) || null,
      instanceId: safeText(payload.instanceId, 128) || null,
      installedApps,
    };
    live.lastSeenAt = new Date().toISOString();
    this.store.setDeviceRevocation(device.deviceId, {
      developerMode: payload.developerMode !== true,
      automation: payload.automation !== true,
    });
    this.store.touchDevice(device.deviceId);
    this.emit({ type: 'device', deviceId: device.deviceId, state: 'ready', developerMode: live.presence.developerMode });
  }

  updateStatus(device, payload) {
    const op = this.store.getOp(requireId(payload.opId, 'opId'));
    if (!op) throw new ProtocolError('unknown_op', 'status names an unknown operation');
    if (op.deviceId !== device.deviceId) throw new ProtocolError('invalid_request', 'operation belongs to another device');
    const next = String(payload.state ?? '');
    if (!isState(next)) throw new ProtocolError('invalid_request', `unknown status: ${next}`);
    if (next === op.state) return;
    if (!canTransition(op.state, next)) {
      this.log(`ignored status ${op.opId}: ${op.state} -> ${next}`);
      return;
    }
    op.state = next;
    op.updatedAt = new Date().toISOString();
    if (payload.error) {
      op.failureLayer = classifyFailure(payload.error);
      op.error = sanitizeError(payload.error);
    }
    if (next === 'failed' && !op.failureLayer) op.failureLayer = 'runtime';
    this.store.saveOp(op);
    this.emit({ type: 'status', opId: op.opId, state: op.state, failureLayer: op.failureLayer, evidenceId: op.evidenceId });
  }

  acceptEvidence(device, payload) {
    const opId = payload.opId ? String(payload.opId) : null;
    const op = opId ? this.store.getOp(opId) : null;
    if (opId && !op) throw new ProtocolError('unknown_op', 'evidence names an unknown operation');
    if (op && op.deviceId !== device.deviceId) throw new ProtocolError('invalid_request', 'operation belongs to another device');
    const releaseId = String(payload.releaseId ?? op?.releaseId ?? '');
    if (!releaseId) throw new ProtocolError('invalid_request', 'evidence requires releaseId');
    if (!releaseId.startsWith('rel_')) throw new ProtocolError('invalid_request', 'invalid releaseId');
    // Evidence describes the instance one operation installed and started. An
    // artifact from another release must not be attached to this operation
    // (018 plan §4.5).
    if (op && releaseId !== op.releaseId) {
      throw new ProtocolError('invalid_request', 'evidence releaseId does not match the operation');
    }

    const bounded = boundReport(payload.report);
    const evidenceId = evidenceIdFor(bounded.report);
    const failure = payload.report?.failure ?? payload.report?.error ?? (payload.failureLayer ? { layer: payload.failureLayer } : null);
    const failureLayer = failure ? classifyFailure(failure) : (op?.failureLayer ?? null);
    const record = {
      evidenceId,
      opId,
      deviceId: device.deviceId,
      releaseId,
      sessionId: payload.sessionId ? String(payload.sessionId).slice(0, 128) : null,
      failureLayer,
      summary: summarizeReport(bounded.report, failureLayer),
      counts: countReport(bounded.report),
      truncated: bounded.truncated,
      droppedEvents: bounded.droppedEvents,
      bytes: bounded.bytes,
      path: join(this.store.paths.evidence, `${evidenceId}.json`),
      receivedAt: new Date().toISOString(),
      report: bounded.report,
    };
    this.store.saveEvidence(record);
    if (op) {
      op.evidenceId = evidenceId;
      if (failureLayer) op.failureLayer = failureLayer;
      op.updatedAt = new Date().toISOString();
      this.store.saveOp(op);
    }
    this.emit({ type: 'evidence', evidenceId, opId, releaseId, failureLayer, truncated: bounded.truncated });
    return { evidenceId };
  }

  acceptCaptureResult(device, payload) {
    const requestId = requireId(payload.requestId, 'requestId');
    const capture = this.store.getCapture(requestId);
    if (!capture || capture.deviceId !== device.deviceId) throw new ProtocolError('invalid_request', 'unknown capture request');
    let screenshotPath = null;
    const mediaType = typeof payload.mediaType === 'string' ? payload.mediaType : 'application/octet-stream';
    if (typeof payload.screenshotBase64 === 'string' && payload.screenshotBase64.length > 0) {
      const bytes = Buffer.from(payload.screenshotBase64, 'base64');
      if (bytes.length > 2 * 1024 * 1024) throw new ProtocolError('invalid_request', 'screenshot exceeds 2 MiB');
      screenshotPath = this.store.saveScreenshot(`${requestId}${extensionFor(mediaType)}`, bytes);
    }
    let tree = payload.tree ?? null;
    if (tree !== null && Buffer.byteLength(JSON.stringify(tree)) > 64 * 1024) {
      throw new ProtocolError('invalid_request', 'capture tree exceeds 64 KiB');
    }
    capture.state = 'done';
    capture.result = {
      tree,
      screenshotPath,
      mediaType,
      note: typeof payload.note === 'string' ? payload.note.slice(0, 512) : null,
    };
    capture.updatedAt = new Date().toISOString();
    capture.updatedAt = new Date().toISOString();
    this.store.saveCapture(capture);
    this.emit({ type: 'capture', requestId, deviceId: device.deviceId, state: 'done' });
  }

  acceptScreenshot(device, payload) {
    const bytes = Buffer.from(String(payload.bytesBase64 ?? ''), 'base64');
    if (bytes.length === 0) throw new ProtocolError('invalid_request', 'empty screenshot');
    if (bytes.length > 2 * 1024 * 1024) throw new ProtocolError('invalid_request', 'screenshot exceeds 2 MiB');
    const name = `${device.deviceId}-${Date.now()}${extensionFor(String(payload.mediaType ?? ''))}`;
    const path = this.store.saveScreenshot(name, bytes);
    this.emit({ type: 'screenshot', deviceId: device.deviceId, path });
  }

  // ------------------------------------------------------------- HTTP/WS I/O

  async handleDeviceHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/artifacts\/([^/]+)$/);
    if (req.method !== 'GET' || !match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found' } }));
      return;
    }
    const token = bearer(req);
    if (!token || !this.findDeviceByToken(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'not_paired' } }));
      return;
    }
    const releaseId = decodeURIComponent(match[1]);
    if (!/^rel_[0-9a-f]{16}(?:_[0-9]+)?$/.test(releaseId)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unknown_release' } }));
      return;
    }
    const path = join(this.store.paths.artifacts, `${releaseId}.nshpkg`);
    if (!existsSync(path)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'unknown_release' } }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': statSync(path).size,
      'x-jiezi-release': releaseId,
    });
    createReadStream(path).pipe(res);
  }

  openEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
    this.eventClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
        this.eventClients.delete(res);
      }
    }, 15_000);
    keepalive.unref?.();
    req.on('close', () => {
      clearInterval(keepalive);
      this.eventClients.delete(res);
    });
  }

  emit(event) {
    const data = JSON.stringify({ ...event, ts: new Date().toISOString() });
    for (const client of this.eventClients) {
      try {
        client.write(`event: ${event.type}\ndata: ${data}\n\n`);
      } catch {
        this.eventClients.delete(client);
      }
    }
  }

  respondError(res, error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof ProtocolError) {
      const status = {
        invalid_request: 400,
        outside_project_root: 403,
        not_paired: 404,
        device_offline: 409,
        unknown_release: 404,
        unknown_op: 404,
        unknown_evidence: 404,
        unknown_pairing_session: 404,
        unknown_automation: 404,
        unknown_open: 404,
        open_unavailable: 409,
        pairing_used: 409,
        pairing_expired: 410,
        pairing_mismatch: 403,
        op_conflict: 409,
        automation_unavailable: 409,
        app_not_active: 409,
        stale_instance: 409,
        project_exists: 409,
        init_failed: 422,
        build_failed: 422,
        timeout: 504,
      }[error.code] ?? 500;
      sendJson(res, status, {
        ok: false,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
      return;
    }
    this.log(`request failed: ${error.stack ?? error.message}`);
    sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'internal bridge error' } });
  }
}

function extensionFor(mediaType) {
  if (mediaType === 'image/png') return '.png';
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/webp') return '.webp';
  return '.bin';
}

function publicCapture(capture) {
  return {
    requestId: capture.requestId,
    deviceId: capture.deviceId,
    state: capture.state,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt ?? null,
    result: capture.result ?? null,
  };
}

function publicOp(op) {
  return {
    opId: op.opId,
    deviceId: op.deviceId,
    releaseId: op.releaseId,
    projectId: op.projectId,
    build: op.build,
    state: op.state,
    failureLayer: op.failureLayer ?? null,
    error: op.error ?? null,
    evidenceId: op.evidenceId ?? null,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

function publicOpen(request) {
  return {
    requestId: request.requestId,
    deviceId: request.deviceId,
    appId: request.appId,
    state: request.state,
    instanceId: request.instanceId ?? null,
    error: request.error ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function publicAutomation(request) {
  return {
    requestId: request.requestId,
    opId: request.opId,
    deviceId: request.deviceId,
    action: request.action,
    state: request.state,
    appId: request.appId ?? null,
    instanceId: request.instanceId ?? null,
    snapshot: request.snapshot ?? null,
    diagnostics: request.diagnostics ?? null,
    hostAlert: request.hostAlert ?? null,
    error: request.error ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function normalizeTarget(value, action) {
  if (action === 'observe') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `${action} requires a target object`);
  }
  const target = {};
  for (const key of ['testID', 'label', 'role', 'alias', 'path']) {
    if (value[key] !== undefined) target[key] = safeText(value[key], key === 'path' ? 256 : 128);
  }
  if (!target.testID && !target.label && !target.alias && !target.path) {
    throw new ProtocolError('invalid_request', 'target requires testID, label, alias, or path');
  }
  return target;
}

function normalizeExpect(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', 'expect must be an object');
  }
  const expect = {};
  for (const key of ['visibleTestID', 'visibleLabel', 'textEquals', 'textContains']) {
    if (value[key] !== undefined) expect[key] = safeText(value[key], 512);
  }
  return Object.keys(expect).length > 0 ? expect : null;
}

export function boundAutomationDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cursor = Math.max(0, Math.trunc(Number(value.cursor) || 0));
  const sequences = Array.isArray(value.sequences)
    ? value.sequences.slice(0, 60).map((item) => Math.max(0, Math.trunc(Number(item) || 0)))
    : [];
  // Event bodies are returned inline so an uncaught error raised by the tapped
  // handler is visible in the same action result (018 plan §4.2).
  const events = Array.isArray(value.events)
    ? value.events.slice(-20).map((event) => ({
        sequence: Math.max(0, Math.trunc(Number(event?.sequence) || 0)),
        level: safeText(event?.level, 16),
        code: event?.code === undefined || event.code === null ? null : safeText(event.code, 100),
        message: safeText(event?.message, 1000),
        timestamp: safeText(event?.timestamp, 64),
      }))
    : [];
  return { cursor, sequences, events };
}

export function boundHostAlert(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    code: safeText(value.code, 64) || 'HOST_ALERT',
    message: safeText(value.message, 1000),
    appId: value.appId ? safeText(value.appId, 128) : null,
    releaseId: value.releaseId ? safeText(value.releaseId, 128) : null,
    instanceId: value.instanceId ? safeText(value.instanceId, 128) : null,
  };
}

function boundAutomationSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('invalid_request', 'snapshot must be an object');
  }
  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const nodes = rawNodes.slice(0, 300).map((node) => ({
    alias: safeText(node?.alias, 16) || null,
    testID: safeText(node?.testID, 256) || null,
    label: safeText(node?.label, 512) || null,
    role: safeText(node?.role, 64) || null,
    value: safeText(node?.value, 512) || null,
    frame: node?.frame && typeof node.frame === 'object'
      ? {
          x: finite(node.frame.x),
          y: finite(node.frame.y),
          width: Math.max(0, finite(node.frame.width)),
          height: Math.max(0, finite(node.frame.height)),
        }
      : null,
    enabled: node?.enabled !== false,
    visible: node?.visible !== false,
    focused: node?.focused === true,
    path: safeText(node?.path, 256) || null,
  }));
  const snapshot = {
    snapshotId: safeText(value.snapshotId, 128) || null,
    appId: safeText(value.appId, 128) || null,
    releaseId: safeText(value.releaseId, 128) || null,
    instanceId: safeText(value.instanceId, 128) || null,
    mode: safeText(value.mode, 32) || 'semantic',
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.slice(0, 8).map((item) => safeText(item, 64)).filter(Boolean)
      : [],
    screen: value.screen && typeof value.screen === 'object'
      ? {
          width: Math.max(0, finite(value.screen.width)),
          height: Math.max(0, finite(value.screen.height)),
        }
      : null,
    nodes,
    truncated: value.truncated === true || rawNodes.length > nodes.length,
  };
  while (snapshot.nodes.length > 0 && Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024) {
    snapshot.nodes = snapshot.nodes.slice(0, Math.floor(snapshot.nodes.length / 2));
    snapshot.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024) {
    throw new ProtocolError('invalid_request', 'automation snapshot exceeds 128 KiB after bounding');
  }
  return snapshot;
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[randomBytes(1)[0] % alphabet.length];
  return code;
}

function firstLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function safeText(value, limit) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, limit);
}

function safeTargetKind(value) {
  return value === 'physical' || value === 'simulator' ? value : null;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function reportEvents(report) {
  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  const sessionEvents = sessions.flatMap((session) => Array.isArray(session?.events) ? session.events : []);
  const topLevelEvents = Array.isArray(report?.events) ? report.events : [];
  const topLevelSnapshots = Array.isArray(report?.snapshots) ? report.snapshots : [];
  const sessionSnapshots = sessions.flatMap((session) => Array.isArray(session?.snapshots) ? session.snapshots : []);
  return { sessions, events: [...topLevelEvents, ...sessionEvents], snapshots: [...topLevelSnapshots, ...sessionSnapshots] };
}

export function summarizeReport(report, failureLayer) {
  const { events } = reportEvents(report);
  const explicit = report?.failure ?? report?.error;
  let error = explicit;
  if (!explicit) {
    // Reports are scoped to one deployed instance, so the newest error is the
    // one that belongs to this deployment. `find` used to return the oldest
    // error in a cross-version archive (018 plan §4.5).
    const errors = events.filter((event) => event?.level === 'error');
    errors.sort((a, b) => {
      const left = Number(a?.sequence);
      const right = Number(b?.sequence);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      return String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? ''));
    });
    error = errors[errors.length - 1];
  }
  const message = typeof error === 'string'
    ? error
    : error?.message ?? error?.code ?? (typeof report?.summary === 'string' ? report.summary : null);
  const code = typeof error === 'object' && error !== null && typeof error.code === 'string'
    ? error.code.slice(0, 100)
    : null;
  return {
    failureLayer,
    code,
    message: message ? String(message).slice(0, 2000) : null,
  };
}

function countReport(report) {
  const { sessions, events, snapshots } = reportEvents(report);
  return {
    sessions: sessions.length,
    events: events.length,
    snapshots: snapshots.length,
  };
}

function sanitizeError(error) {
  if (!error || typeof error !== 'object') return { code: 'unknown', message: String(error).slice(0, 1000) };
  return {
    code: String(error.code ?? 'unknown').slice(0, 100),
    message: String(error.message ?? '').slice(0, 2000),
  };
}

function requireId(value, name) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(text) || text === '.' || text === '..') {
    throw new ProtocolError('invalid_request', `${name} is required and must be a safe identifier`);
  }
  return text;
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : null;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new ProtocolError('invalid_request', 'request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('object required');
    }
    return value;
  } catch {
    throw new ProtocolError('invalid_request', 'request body must be a JSON object');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function listen(server, options) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function prepareSocket(path) {
  if (!existsSync(path)) return;
  const alive = await new Promise((resolvePromise) => {
    const socket = netConnect(path);
    const finish = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 300).unref?.();
  });
  if (alive) {
    throw new ProtocolError('busy', `another bridge is already listening at ${path}`);
  }
  try {
    unlinkSync(path);
  } catch {
    // Another process may have cleaned it up first.
  }
}

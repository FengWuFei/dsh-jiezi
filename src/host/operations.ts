/**
 * Delivery operations shared by the Host API routes and the model-facing
 * tools. One implementation means the panel and the Agent act on the same
 * bridge calls and report the same bounded results.
 *
 * The bridge stays authoritative for devices, operations, evidence, pairing,
 * and automation. This layer only bounds results, remembers the newest pairing
 * session so the QR can be shown again, and keeps a small recent-automation
 * list for the panel because the bridge protocol exposes no list endpoint.
 */

import {
  MAX_AUTOMATION_HISTORY,
  MAX_DEPLOYMENTS,
  MAX_DEVICES,
  automationAlert,
  automationDiagnostics,
  automationSnapshot,
  automationView,
  boundedNumber,
  deploymentView,
  deviceView,
  evaluateExpectation,
  formatOutline,
  parseAutomationArgs,
  parseBuildArgs,
  parseCaptureArgs,
  parseDeployArgs,
  parseDeviceOperationArgs,
  parseDiagnosticsArgs,
  parseInitArgs,
  parseOpenArgs,
  parsePairingCreateArgs,
  parseScreenArgs,
  requireAction,
  requireString,
  validatePairingPayload,
  type AutomationAction,
  type AutomationAlert,
  type AutomationArgs,
  type AutomationDiagnosticEvent,
  type AutomationDiagnostics,
  type AutomationSnapshot,
  type AutomationView,
  type CaptureArgs,
  type DeploymentView,
  type DeviceView,
  type OpenArgs,
  type PairingPayload,
  type PairingView,
  type ScreenArgs,
  type StatusView,
  type SetupInitializeResult,
  type SetupReport,
} from '../shared/protocol.js';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JieZiError } from '../shared/errors.js';
import { BridgeClient, resolveBridgeSettings, type BridgeSettings } from './bridge-client.js';
import { BridgeSupervisor } from './bridge-supervisor.js';
import { initializeSetup, inspectSetup } from './setup.js';
import { AppleDeviceHost, type DeviceHost } from './apple-device-host.js';

/** One automation call's bounded result. */
export interface AutomationResult {
  ok: boolean;
  action: 'observe' | 'tap' | 'type' | 'scroll';
  requestId: string;
  state: string;
  deviceId: string;
  opId: string | null;
  appId: string | null;
  instanceId: string | null;
  snapshotId: string | null;
  nodeCount: number;
  outline: string | null;
  error: { code: string; message: string } | null;
  verification: { passed: boolean; reason: string | null };
  diagnostics: AutomationDiagnostics | null;
  diagnosticCursor: number | null;
  hostAlert: AutomationAlert | null;
  runtimeError: AutomationDiagnosticEvent | null;
  deduplicated: boolean;
}

interface PairingMemory {
  payload: PairingPayload;
  bridgeName: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAutomationReady(device: DeviceView): boolean {
  return device.online && device.developerMode && device.automation;
}

/** A durable revocation blocks offline launch; a live ready envelope can replace it. */
function isAutomationRevoked(device: DeviceView): boolean {
  const durable = device.revocation?.automation === true
    && (!device.online || device.activeApp !== null);
  return durable
    || (device.online && device.activeApp !== null && device.developerMode && !device.automation);
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JieZiError('bridge_protocol', `bridge returned a malformed ${what}`);
  }
  return value as Record<string, unknown>;
}

/** A capture-start result carries the capture fields at top level; a poll wraps them. */
function captureRecordOf(value: Record<string, unknown>): Record<string, unknown> {
  const capture = value.capture;
  return capture !== null && typeof capture === 'object' && !Array.isArray(capture)
    ? capture as Record<string, unknown>
    : value;
}

/** Bridge-shaped pairing response. */
interface BridgePairingResponse {
  ok?: boolean;
  pairing: {
    sessionId?: unknown;
    code?: unknown;
    endpoint?: unknown;
    certificateFingerprint?: unknown;
    expiresAt?: unknown;
    bridgeName?: unknown;
    state?: unknown;
    deviceId?: unknown;
  };
}

/** Shared operations instance for one resolved bridge socket. */
const instances = new Map<string, JieZiOperations>();

/** Get (or create) the process-wide operations instance for these settings. */
export function getSharedOperations(config: unknown = {}): JieZiOperations {
  const settings = resolveBridgeSettings(config);
  const key = `${settings.socketPath}\u0000${settings.timeoutMs}\u0000${settings.stateDir}\u0000${settings.bridgeCliPath}\u0000${settings.autoStart}`;
  const existing = instances.get(key);
  if (existing !== undefined) return existing;
  const created = new JieZiOperations(settings);
  instances.set(key, created);
  return created;
}

/** All delivery operations; no HTTP and no Cordis dependency lives here. */
export class JieZiOperations {
  readonly client: BridgeClient;
  readonly deviceHost: DeviceHost;
  private readonly bridgeSupervisor: BridgeSupervisor | null;
  private lastPairing: PairingMemory | null = null;
  private readonly deploymentHistory: DeploymentView[] = [];
  private readonly automationHistory: AutomationView[] = [];

  constructor(readonly settings: BridgeSettings, deviceHost?: DeviceHost) {
    this.bridgeSupervisor = settings.autoStart ? new BridgeSupervisor(settings) : null;
    this.client = new BridgeClient(
      settings,
      this.bridgeSupervisor === null ? undefined : () => this.bridgeSupervisor?.ensureRunning() ?? Promise.resolve(),
    );
    this.deviceHost = deviceHost ?? new AppleDeviceHost(settings.stateDir);
  }

  /** Start the configured bridge on demand; never initializes pairing state. */
  async ensureBridge(): Promise<void> {
    if (this.bridgeSupervisor !== null) {
      await this.bridgeSupervisor.ensureRunning();
      return;
    }
    await this.client.get('/v1/health');
  }

  /** Test lifecycle hook; production effects intentionally leave the service alive. */
  async stopOwnedBridge(): Promise<void> {
    await this.bridgeSupervisor?.stopOwned();
  }

  /** Read-only environment report for the panel's setup card. */
  async setupReport(): Promise<SetupReport> {
    return inspectSetup(this.settings);
  }

  /**
   * Run the packaged bridge `init` after explicit user consent. Activation
   * never calls this; an existing config is returned as already initialized.
   */
  async setupInitialize(args: unknown): Promise<SetupInitializeResult> {
    return initializeSetup(this.settings, args);
  }

  /* ------------------------------------------------------------- summary */

  /**
   * Everything the panel needs in one read. A stopped bridge is a normal,
   * actionable state here rather than an HTTP failure, so the panel can show
   * the start command instead of an empty error box.
   */
  async status(): Promise<StatusView> {
    const warnings: string[] = [];
    let bridge: StatusView['bridge'] = {
      available: false,
      version: null,
      bridgeName: this.lastPairing?.bridgeName ?? null,
      deviceUrl: null,
      projectRoot: null,
      capabilities: [],
      error: null,
    };
    let devices: DeviceView[] = [];
    let deployments: DeploymentView[] = [];

    try {
      const health = recordOf(await this.client.get('/v1/health'), 'health');
      bridge = {
        available: true,
        version: typeof health.version === 'string' ? health.version : null,
        bridgeName: this.lastPairing?.bridgeName ?? null,
        deviceUrl: typeof health.deviceUrl === 'string' ? health.deviceUrl : null,
        projectRoot: typeof health.projectRoot === 'string' ? health.projectRoot : null,
        capabilities: Array.isArray(health.capabilities)
          ? health.capabilities.filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
          : [],
        error: null,
      };
    } catch (error) {
      const failure = error instanceof JieZiError ? error : new JieZiError('bridge_protocol', 'bridge health read failed');
      bridge = { ...bridge, error: { code: failure.code, message: failure.message } };
    }

    if (bridge.available) {
      const [deviceResult, opResult] = await Promise.allSettled([this.devices(), this.operation({})]);
      if (deviceResult.status === 'fulfilled') {
        devices = deviceResult.value.devices;
      } else {
        warnings.push('devices could not be read from the bridge');
      }
      if (opResult.status === 'fulfilled') {
        deployments = opResult.value.ops?.slice(0, MAX_DEPLOYMENTS) ?? [];
      } else {
        warnings.push('recent delivery operations could not be read from the bridge');
      }
    } else {
      deployments = this.deploymentHistory.slice(0, MAX_DEPLOYMENTS);
    }

    return {
      ok: true,
      bridge,
      setup: {
        initialized: existsSync(join(this.settings.stateDir, 'config.json')),
        stateDir: this.settings.stateDir,
        bridgeCliPath: this.settings.bridgeCliPath,
        bridgeCliAvailable: existsSync(this.settings.bridgeCliPath),
      },
      pairing: await this.currentPairingView(),
      devices,
      deployments,
      automation: this.automationHistory.slice(0, MAX_AUTOMATION_HISTORY),
      warnings,
      fetchedAt: new Date().toISOString(),
    };
  }

  /* ------------------------------------------------------------- pairing */

  /** Create one single-use pairing session and return the exact QR payload. */
  async createPairing(args: unknown = {}): Promise<{ ok: true; pairing: PairingView }> {
    const { ttlMs } = parsePairingCreateArgs(args);
    const response = recordOf(
      await this.client.post('/v1/pairing-sessions', { ttlMs }),
      'pairing session',
    ) as unknown as BridgePairingResponse;
    const raw = recordOf(response.pairing, 'pairing session');
    const payload = validatePairingPayload({
      schema: 'jiezi.pairing.v1',
      sessionId: raw.sessionId,
      endpoint: raw.endpoint,
      code: raw.code,
      certificateFingerprint: raw.certificateFingerprint ?? null,
      expiresAt: raw.expiresAt,
    });
    this.lastPairing = {
      payload,
      bridgeName: typeof raw.bridgeName === 'string' ? raw.bridgeName.slice(0, 128) : null,
    };
    return {
      ok: true,
      pairing: {
        payload,
        state: 'waiting',
        deviceId: null,
        bridgeName: this.lastPairing.bridgeName,
        expiresAt: payload.expiresAt,
      },
    };
  }

  /** Read one session's state; the payload is included only for the remembered session. */
  async pairingStatus(args: { sessionId?: string } = {}): Promise<{ ok: true; pairing: PairingView }> {
    const requested = args.sessionId === undefined ? this.lastPairing?.payload.sessionId : requireString(args.sessionId, 'sessionId', 128);
    if (requested === undefined) {
      return { ok: true, pairing: { payload: null, state: 'none', deviceId: null, bridgeName: null, expiresAt: null } };
    }
    try {
      const response = recordOf(
        await this.client.get(`/v1/pairing-sessions/${encodeURIComponent(requested)}`),
        'pairing status',
      ) as unknown as BridgePairingResponse;
      const raw = recordOf(response.pairing, 'pairing status');
      const state = raw.state === 'paired' || raw.state === 'expired' ? raw.state : 'waiting';
      const remembered = this.lastPairing?.payload.sessionId === requested ? this.lastPairing : null;
      return {
        ok: true,
        pairing: {
          payload: remembered?.payload ?? null,
          state,
          deviceId: typeof raw.deviceId === 'string' ? raw.deviceId.slice(0, 256) : null,
          bridgeName: remembered?.bridgeName ?? null,
          expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : remembered?.payload.expiresAt ?? null,
        },
      };
    } catch (error) {
      if (error instanceof JieZiError && error.code === 'unknown_pairing_session') {
        return {
          ok: true,
          pairing: {
            payload: this.lastPairing?.payload ?? null,
            state: 'expired',
            deviceId: null,
            bridgeName: this.lastPairing?.bridgeName ?? null,
            expiresAt: this.lastPairing?.payload.expiresAt ?? null,
          },
        };
      }
      throw error;
    }
  }

  /** Stop showing the remembered session in this panel; no bridge state changes. */
  disconnectPairing(): { ok: true } {
    this.lastPairing = null;
    return { ok: true };
  }

  /** Ask the bridge to forget a paired device. */
  async unpair(args: unknown = {}): Promise<{ ok: true; deviceId: string }> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new JieZiError('invalid_request', 'body must be an object');
    }
    const body = args as Record<string, unknown>;
    const deviceId = requireString(body.deviceId, 'deviceId', 256);
    try {
      await this.client.post('/v1/unpair', { deviceId });
      this.deviceHost.removeBinding(deviceId);
      return { ok: true, deviceId };
    } catch (error) {
      if (error instanceof JieZiError && /unknown route|not found|404/i.test(error.message)) {
        throw new JieZiError(
          'unsupported',
          '当前 jiezi-bridge 未提供解除配对接口。请先在 iPhone 上退出开发者模式，或删除 bridge 状态目录中的设备记录后重启 bridge。',
        );
      }
      throw error;
    }
  }

  private async currentPairingView(): Promise<PairingView> {
    if (this.lastPairing === null) {
      return { payload: null, state: 'none', deviceId: null, bridgeName: null, expiresAt: null };
    }
    try {
      const { pairing } = await this.pairingStatus({});
      return pairing;
    } catch {
      return {
        payload: this.lastPairing.payload,
        state: 'expired',
        deviceId: null,
        bridgeName: this.lastPairing.bridgeName,
        expiresAt: this.lastPairing.payload.expiresAt,
      };
    }
  }

  /* ------------------------------------------------------------- devices */

  /** Bounded paired-device list. */
  async devices(): Promise<{ ok: true; devices: DeviceView[] }> {
    const response = recordOf(await this.client.get('/v1/devices'), 'device list');
    const list = Array.isArray(response.devices) ? response.devices : [];
    return { ok: true, devices: list.slice(0, MAX_DEVICES).map(deviceView) };
  }

  /** Discover/bind/launch lifecycle targets, or recover one paired device. */
  async device(args: unknown): Promise<Record<string, unknown>> {
    const request = parseDeviceOperationArgs(args);
    if (request.action === 'list') {
      const [paired, targets] = await Promise.all([this.devices(), this.deviceHost.listTargets()]);
      return {
        ok: true,
        devices: paired.devices,
        targets,
        bindings: this.deviceHost.listBindings(),
      };
    }
    return this.ensureReady({
      deviceId: request.deviceId as string,
      hostDeviceId: request.hostDeviceId,
      rebind: request.rebind,
      waitMs: request.waitMs,
    });
  }

  /** Launch only when necessary, then verify presence rather than process exit. */
  async ensureReady(args: {
    deviceId: string;
    hostDeviceId?: string;
    rebind?: boolean;
    waitMs?: number;
  }): Promise<Record<string, unknown>> {
    await this.ensureBridge();
    const initial = await this.pairedDevice(args.deviceId);
    if (isAutomationReady(initial)) {
      return {
        ok: true,
        state: 'ready',
        deviceId: args.deviceId,
        launched: false,
        recovered: false,
        device: initial,
        binding: this.deviceHost.listBindings().find((item) => item.deviceId === args.deviceId) ?? null,
      };
    }
    if (isAutomationRevoked(initial)) {
      throw new JieZiError('automation_disabled', 'The user stopped developer automation on this device; the Host will not re-enable it.', { retryable: false });
    }

    const { binding, target } = await this.deviceHost.resolveBinding({
      deviceId: args.deviceId,
      deviceName: initial.name,
      targetKind: initial.targetKind,
      ...(args.hostDeviceId === undefined ? {} : { hostDeviceId: args.hostDeviceId }),
      rebind: args.rebind === true,
    });
    await this.deviceHost.launch(target);

    const deadline = Date.now() + (args.waitMs ?? 30_000);
    let latest = initial;
    while (Date.now() < deadline) {
      await sleep(500);
      latest = await this.pairedDevice(args.deviceId);
      if (isAutomationReady(latest)) {
        return {
          ok: true,
          state: 'ready',
          deviceId: args.deviceId,
          hostDeviceId: target.hostDeviceId,
          launched: true,
          recovered: true,
          device: latest,
          binding,
        };
      }
      if (isAutomationRevoked(latest)) {
        throw new JieZiError('automation_disabled', 'The paired App connected with automation disabled; explicit user revocation is not overridden.', { retryable: false });
      }
    }
    throw new JieZiError(
      'device_not_ready',
      `JieZi host launch did not produce developer automation within ${Math.trunc((args.waitMs ?? 30_000) / 1000)}s. Last device state: online=${latest.online}, developerMode=${latest.developerMode}, automation=${latest.automation}. Check that the App is installed, the device is unlocked, and the pairing has not been revoked.`,
    );
  }

  private async pairedDevice(deviceId: string): Promise<DeviceView> {
    const result = await this.devices();
    const device = result.devices.find((item) => item.deviceId === deviceId);
    if (!device) throw new JieZiError('not_paired', `No paired device named ${deviceId}`, { retryable: false });
    return device;
  }

  /* ------------------------------------------------------------ delivery */

  /**
   * Initialize one new project. `root` is the Session working directory the
   * bridge should create it under; without one the bridge's configured project
   * root applies.
   */
  async init(args: unknown, root?: string): Promise<Record<string, unknown>> {
    const request = parseInitArgs(args);
    const body: Record<string, unknown> = { ...request, layout: this.settings.projectLayout };
    if (root !== undefined) body.root = root;
    return recordOf(await this.client.post('/v1/projects/init', body), 'project init result');
  }

  /** Build one project through the bridge; `root` mirrors `init`'s session root. */
  async build(args: unknown, root?: string): Promise<Record<string, unknown>> {
    const request = parseBuildArgs(args);
    const body: Record<string, unknown> = { projectId: request.projectId, layout: this.settings.projectLayout };
    if (request.projectDir !== undefined) body.projectDir = request.projectDir;
    if (root !== undefined) body.root = root;
    return recordOf(await this.client.post('/v1/build', body), 'build result');
  }

  /** Queue one release for one device. */
  async deploy(args: unknown): Promise<Record<string, unknown>> {
    const request = parseDeployArgs(args);
    if (this.settings.autoStart) await this.ensureReady({ deviceId: request.deviceId });
    const result = recordOf(
      await this.client.post('/v1/deploy', { deviceId: request.deviceId, releaseId: request.releaseId }),
      'deploy result',
    );
    if (typeof result.opId === 'string') {
      this.rememberDeployment(deploymentView({ ...result, deviceId: request.deviceId, releaseId: request.releaseId }));
    }
    return result;
  }

  /** Read one operation, or the recent list for a device. */
  async operation(args: { opId?: string; deviceId?: string } = {}): Promise<{
    ok: true;
    op?: Record<string, unknown>;
    ops?: DeploymentView[];
  }> {
    if (args.opId !== undefined) {
      const opId = requireString(args.opId, 'opId', 256);
      const response = recordOf(await this.client.get(`/v1/ops/${encodeURIComponent(opId)}`), 'operation');
      const op = recordOf(response.op, 'operation');
      this.rememberDeployment(deploymentView(op));
      return { ok: true, op };
    }
    const query = args.deviceId === undefined ? '' : `?deviceId=${encodeURIComponent(requireString(args.deviceId, 'deviceId', 256))}`;
    const response = recordOf(await this.client.get(`/v1/ops${query}`), 'operation list');
    const list = Array.isArray(response.ops) ? response.ops : [];
    const ops = list.slice(0, MAX_DEPLOYMENTS).map(deploymentView);
    for (const op of ops) this.rememberDeployment(op);
    return { ok: true, ops };
  }

  /** Read bounded evidence for one operation or evidence id. */
  async diagnostics(args: unknown): Promise<Record<string, unknown>> {
    const request = parseDiagnosticsArgs(args);
    let evidenceId = request.evidenceId ?? null;
    if (evidenceId === null) {
      const opId = request.opId;
      if (opId === undefined) throw new JieZiError('invalid_request', 'opId or evidenceId is required');
      const op = await this.operation({ opId });
      const evidence = op.op?.evidenceId;
      evidenceId = typeof evidence === 'string' ? evidence : null;
      if (evidenceId === null) {
        return {
          ok: false,
          code: 'evidence_pending',
          message: 'No evidence has arrived for this operation yet.',
          state: typeof op.op?.state === 'string' ? op.op.state : null,
          failureLayer: typeof op.op?.failureLayer === 'string' ? op.op.failureLayer : null,
        };
      }
    }
    return recordOf(await this.client.get(`/v1/evidence/${encodeURIComponent(evidenceId)}`), 'evidence');
  }

  /** Ask one device for a page tree/screenshot and wait briefly. */
  async capture(args: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
    const request: CaptureArgs = parseCaptureArgs(args);
    if (this.settings.autoStart && request.requestId === undefined) {
      await this.ensureReady({ deviceId: request.deviceId });
    }
    const started = request.requestId === undefined
      ? recordOf(await this.client.post('/v1/capture', { deviceId: request.deviceId }), 'capture start')
      : { requestId: request.requestId, state: 'pending' };
    const requestId = requireString(started.requestId, 'requestId', 256);
    const deadline = Date.now() + request.waitMs;
    let current: Record<string, unknown> = started;
    while (true) {
      const capture = captureRecordOf(current);
      if (capture.state === 'done' || Date.now() >= deadline) break;
      await sleep(150);
      current = recordOf(
        await this.client.get(`/v1/captures/${encodeURIComponent(requestId)}`),
        'capture',
      );
    }
    const capture = captureRecordOf(current);
    if (typeof capture.deviceId === 'string' && capture.deviceId !== request.deviceId) {
      throw new JieZiError('invalid_request', 'capture belongs to another device');
    }
    if (capture.state !== 'done') {
      return { ok: true, requestId, state: 'pending', waitedMs: request.waitMs };
    }
    const result = capture.result !== null && typeof capture.result === 'object' && !Array.isArray(capture.result)
      ? capture.result as Record<string, unknown>
      : {};
    return {
      ok: true,
      requestId: typeof capture.requestId === 'string' ? capture.requestId : requestId,
      state: 'done',
      deviceId: typeof capture.deviceId === 'string' ? capture.deviceId : request.deviceId,
      tree: result.tree ?? null,
      screenshotPath: typeof result.screenshotPath === 'string' ? result.screenshotPath : null,
      note: typeof result.note === 'string' ? result.note : null,
    };
  }

  /* ---------------------------------------------------------- open app */

  /** Open one installed app after a restart; no artifact is downloaded. */
  async open(args: unknown): Promise<Record<string, unknown>> {
    const request: OpenArgs = parseOpenArgs(args);
    if (this.settings.autoStart) await this.ensureReady({ deviceId: request.deviceId });
    const started = recordOf(await this.client.post('/v1/open', {
      deviceId: request.deviceId,
      appId: request.appId,
      timeoutMs: request.timeoutMs,
    }), 'open start');
    const initial = recordOf(started.request, 'open request');
    const requestId = requireString(initial.requestId, 'requestId', 256);
    const deadline = Date.now() + request.timeoutMs + 2_000;
    let current = initial;
    while (current.state === 'pending' && Date.now() < deadline) {
      await sleep(150);
      current = recordOf(
        await this.client.get(`/v1/open/${encodeURIComponent(requestId)}`),
        'open status',
      ).request as Record<string, unknown>;
    }
    const state = typeof current.state === 'string' ? current.state : 'pending';
    const error = current.error !== null && typeof current.error === 'object' && !Array.isArray(current.error)
      ? {
          code: typeof (current.error as Record<string, unknown>).code === 'string'
            ? ((current.error as Record<string, unknown>).code as string).slice(0, 64)
            : 'OPEN_FAILED',
          message: typeof (current.error as Record<string, unknown>).message === 'string'
            ? ((current.error as Record<string, unknown>).message as string).slice(0, 500)
            : 'the device did not open the app',
        }
      : null;
    return {
      ok: state === 'done' && error === null,
      requestId,
      state,
      deviceId: request.deviceId,
      appId: request.appId,
      instanceId: typeof current.instanceId === 'string' ? current.instanceId : null,
      error,
    };
  }

  /* ------------------------------------------------------------ screen */

  /** Capture the whole device screen through the host adapter, path only. */
  async screen(args: unknown): Promise<Record<string, unknown>> {
    const request: ScreenArgs = parseScreenArgs(args);
    if (this.settings.autoStart) await this.ensureBridge();
    const device = await this.pairedDevice(request.deviceId);
    const resolved = await this.deviceHost.resolveBinding({
      deviceId: device.deviceId,
      deviceName: device.name,
      targetKind: device.targetKind,
      ...(request.hostDeviceId === undefined ? {} : { hostDeviceId: request.hostDeviceId }),
    });
    const directory = join(this.settings.stateDir, 'screenshots');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(
      directory,
      `screen_${randomUUID().replaceAll('-', '').slice(0, 16)}.png`,
    );
    await this.deviceHost.captureScreen(resolved.target, path);
    return {
      ok: true,
      deviceId: device.deviceId,
      hostDeviceId: resolved.target.hostDeviceId,
      kind: resolved.target.kind,
      path,
    };
  }

  /* ---------------------------------------------------------- automation */

  /**
   * Run one semantic observe/tap request and wait for its terminal state.
   * A failed or timed-out request is returned as data, not thrown, so the model
   * sees the bridge's own error object.
   */
  async automation(args: AutomationArgs): Promise<AutomationResult> {
    if (this.settings.autoStart) await this.ensureReady({ deviceId: args.deviceId });
    const body: Record<string, unknown> = {
      deviceId: args.deviceId,
      opId: args.opId,
      action: args.action,
      timeoutMs: args.timeoutMs,
    };
    if (args.appId !== undefined) body.appId = args.appId;
    if (args.instanceId !== undefined) body.instanceId = args.instanceId;
    if (args.snapshotId !== undefined) body.snapshotId = args.snapshotId;
    if (args.diagnosticCursor !== undefined) body.diagnosticCursor = args.diagnosticCursor;
    if (args.target !== undefined) body.target = args.target;
    if (args.expect !== undefined) body.expect = args.expect;
    if (args.text !== undefined) body.text = args.text;
    if (args.replace !== undefined) body.replace = args.replace;
    if (args.direction !== undefined) body.direction = args.direction;
    if (args.amount !== undefined) body.amount = args.amount;

    const started = recordOf(await this.client.post('/v1/automation', body), 'automation start');
    let current = recordOf(started.request, 'automation request');
    const requestId = requireString(current.requestId, 'requestId', 256);
    const deadline = Date.now() + args.timeoutMs + 5_000;
    while (current.state === 'pending' && Date.now() < deadline) {
      await sleep(200);
      const polled = recordOf(await this.client.get(`/v1/automation/${encodeURIComponent(requestId)}`), 'automation status');
      current = recordOf(polled.request, 'automation request');
    }

    const snapshot: AutomationSnapshot | null = automationSnapshot(current);
    let view = automationView(current, {
      requestId,
      opId: args.opId,
      deviceId: args.deviceId,
      action: args.action,
    });
    const verification = evaluateExpectation(args.expect, snapshot);
    const diagnostics = automationDiagnostics(current.diagnostics);
    const hostAlert = automationAlert(current.hostAlert);
    const runtimeError = newestError(diagnostics);
    let error = current.error === null || current.error === undefined
      ? null
      : {
          code: typeof (current.error as Record<string, unknown>).code === 'string'
            ? ((current.error as Record<string, unknown>).code as string).slice(0, 64)
            : 'unknown',
          message: typeof (current.error as Record<string, unknown>).message === 'string'
            ? ((current.error as Record<string, unknown>).message as string).slice(0, 500)
            : 'automation failed',
        };
    if (error === null && view.state === 'done' && !verification.passed) {
      error = {
        code: 'expectation_failed',
        message: verification.reason ?? '动作后的页面没有满足期望',
      };
    }
    if (error !== null && view.state === 'done') {
      view = { ...view, state: 'failed', error };
    }
    this.rememberAutomation(view);
    return {
      ok: view.state === 'done',
      action: args.action,
      requestId: view.requestId,
      state: view.state,
      deviceId: view.deviceId,
      opId: view.opId,
      appId: view.appId,
      instanceId: view.instanceId,
      snapshotId: snapshot?.snapshotId ?? null,
      nodeCount: snapshot?.nodes.length ?? 0,
      outline: snapshot === null ? null : formatOutline(snapshot, { frames: args.includeFrames === true }),
      error,
      verification,
      diagnostics,
      diagnosticCursor: diagnostics?.cursor ?? null,
      hostAlert,
      runtimeError,
      deduplicated: started.deduplicated === true,
    };
  }

  /**
   * Start one semantic observe/tap request from a raw API body (used by the
   * browser panel and the tools through the same validation).
   */
  startAutomation(body: unknown): Promise<AutomationResult> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return Promise.reject(new JieZiError('invalid_request', 'body must be an object'));
    }
    const record = body as Record<string, unknown>;
    const action: AutomationAction = requireAction(record.action);
    return this.automation(parseAutomationArgs(action, record));
  }

  /** Read one automation request's current state without starting a new one. */
  async automationStatus(args: { requestId: string }): Promise<{
    ok: true;
    automation: AutomationView;
    outline: string | null;
  }> {
    const requestId = requireString(args.requestId, 'requestId', 256);
    const response = recordOf(
      await this.client.get(`/v1/automation/${encodeURIComponent(requestId)}`),
      'automation status',
    );
    const request = recordOf(response.request, 'automation request');
    const snapshot = automationSnapshot(request);
    const view = automationView(request, {
      requestId,
      opId: null,
      deviceId: '',
      action: request.action === 'tap' || request.action === 'type' || request.action === 'scroll' ? request.action : 'observe',
    });
    this.rememberAutomation(view);
    return { ok: true, automation: view, outline: snapshot === null ? null : formatOutline(snapshot) };
  }

  /** Latest automation outcomes for the panel; the Agent's tool calls land here too. */
  recentAutomation(): AutomationView[] {
    return this.automationHistory.slice(0, MAX_AUTOMATION_HISTORY);
  }

  /* --------------------------------------------------------------- memory */

  private rememberDeployment(view: DeploymentView): void {
    if (view.opId.length === 0) return;
    const existing = this.deploymentHistory.findIndex((entry) => entry.opId === view.opId);
    if (existing >= 0) this.deploymentHistory.splice(existing, 1);
    this.deploymentHistory.unshift(view);
    this.deploymentHistory.splice(MAX_DEPLOYMENTS);
  }

  private rememberAutomation(view: AutomationView): void {
    const existing = this.automationHistory.findIndex((entry) => entry.requestId === view.requestId);
    if (existing >= 0) this.automationHistory.splice(existing, 1);
    this.automationHistory.unshift(view);
    this.automationHistory.splice(MAX_AUTOMATION_HISTORY);
  }
}

/** The newest error event in an automation's bounded diagnostic delta. */
function newestError(diagnostics: AutomationDiagnostics | null): AutomationDiagnosticEvent | null {
  if (diagnostics === null) return null;
  const errors = diagnostics.events.filter((event) => event.level === 'error');
  return errors.length === 0 ? null : errors[errors.length - 1];
}

/** Small helper used by the routes for numeric query fields. */
export function queryNumber(value: string | null, name: string, fallback: number, min: number, max: number): number {
  return boundedNumber(value === null ? undefined : value, name, fallback, min, max);
}

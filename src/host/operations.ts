/**
 * Delivery operations shared by the Host API routes and the model-facing
 * tools. One implementation means the panel and the Agent act on the same
 * bridge calls and report the same bounded results.
 *
 * The bridge stays authoritative for devices, operations, evidence, pairing,
 * and automation. This layer bounds results, restores global pairing from the
 * durable device registry after a Host reload, remembers an explicit QR flow,
 * and keeps a small recent-automation list for the panel because the bridge
 * protocol exposes no list endpoint.
 */

import {
  MAX_AUTOMATION_HISTORY,
  MAX_DEPLOYMENTS,
  MAX_DEVICES,
  MIN_HOST_VERSION,
  automationAlert,
  automationDiagnostics,
  automationSnapshot,
  automationView,
  boundedNumber,
  deploymentView,
  deviceView,
  durablePairingView,
  evaluateExpectation,
  formatOutline,
  hostCompatibility,
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
  optionalString,
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
  type HostInfo,
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
import {
  BridgeClient,
  bridgeIdentityFor,
  bundledBridgeVersion,
  resolveBridgeSettings,
  type BridgeIdentity,
  type BridgeSettings,
} from './bridge-client.js';
import { BridgeSupervisor } from './bridge-supervisor.js';
import { initializeSetup, inspectSetup, repairSetup } from './setup.js';
import { AppleDeviceHost, type DeviceHost, type HostDeviceTarget } from './apple-device-host.js';

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
  error: { code: string; message: string; category?: 'device' | 'host' | 'runtime' | 'verification' } | null;
  verification: { passed: boolean; reason: string | null };
  diagnostics: AutomationDiagnostics | null;
  diagnosticCursor: number | null;
  hostAlert: AutomationAlert | null;
  host: HostInfo;
  runtimeError: AutomationDiagnosticEvent | null;
  deduplicated: boolean;
  snapshotIssues: {
    visibleNodeCount: number;
    hiddenNodeCount: number;
    duplicateTestIDs: string[];
  };
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

/** Human-readable failure text for warnings; never leaks a stack. */
function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Host version projection used by tools and doctor. */
function hostOf(device: DeviceView): HostInfo {
  return {
    deviceId: device.deviceId,
    version: device.hostVersion,
    minimumVersion: MIN_HOST_VERSION,
    compatibility: device.hostCompatibility,
  };
}

/** Match one paired device to the CoreDevice target it was bound to (or named like). */
function targetFor(
  device: DeviceView,
  targets: HostDeviceTarget[],
  bindings: Array<{ deviceId: string; hostDeviceId: string }>,
): HostDeviceTarget | null {
  const binding = bindings.find((item) => item.deviceId === device.deviceId) ?? null;
  if (binding !== null) {
    const bound = targets.find((item) => item.hostDeviceId === binding.hostDeviceId);
    if (bound !== undefined) return bound;
  }
  const name = device.name.trim().toLowerCase();
  const named = targets.filter((item) => item.name.trim().toLowerCase() === name);
  if (named.length === 1) return named[0];
  const sameKind = targets.filter((item) => device.targetKind === null || item.kind === device.targetKind);
  return sameKind.length === 1 ? sameKind[0] : null;
}

/**
 * Add the explicit pairing/presence/Host fields. `online` (WebSocket presence)
 * is not CoreDevice pairing and not Host installation; keep them separate so an
 * Agent never reads one as the other.
 */
function enrichDevice(
  device: DeviceView,
  targets: HostDeviceTarget[],
  bindings: Array<{ deviceId: string; hostDeviceId: string }>,
): DeviceView {
  const target = targetFor(device, targets, bindings);
  const binding = bindings.find((item) => item.deviceId === device.deviceId) ?? null;
  const compatibility = hostCompatibility(device.hostVersion);
  let nextAction: string | null = null;
  if (compatibility === 'outdated') {
    nextAction = `Update the JieZi Host App (installed ${device.hostVersion ?? 'unknown'}, minimum ${MIN_HOST_VERSION}); 0.1.x can show the freeze-snapshot alert.`;
  } else if (!device.online) {
    nextAction = target !== null
      ? `Launch the Host with miniapp { action: "device", deviceAction: "launch_host", deviceId: "${device.deviceId}" }.`
      : 'Unlock the iPhone and open the JieZi Host App, then refresh.';
  } else if (!device.developerMode) {
    nextAction = 'Open developer mode in the JieZi Host App.';
  } else if (!device.automation) {
    nextAction = 'Start automation in the JieZi Host App.';
  }
  return {
    ...device,
    jieziPaired: true,
    coreDevicePaired: target?.paired ?? null,
    hostRunning: device.online,
    hostMinimumVersion: MIN_HOST_VERSION,
    hostCompatibility: compatibility,
    boundHostDeviceId: binding?.hostDeviceId ?? null,
    nextAction,
  };
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
  private readonly probeClient: BridgeClient;
  private readonly expectedIdentity: BridgeIdentity | null;
  private lastPairing: PairingMemory | null = null;
  private readonly deploymentHistory: DeploymentView[] = [];
  private readonly automationHistory: AutomationView[] = [];

  constructor(readonly settings: BridgeSettings, deviceHost?: DeviceHost) {
    this.bridgeSupervisor = settings.autoStart ? new BridgeSupervisor(settings) : null;
    this.client = new BridgeClient(
      settings,
      this.bridgeSupervisor === null ? undefined : () => this.bridgeSupervisor?.ensureRunning() ?? Promise.resolve(),
    );
    // Read-only probes (status/doctor) must not start a bridge.
    this.probeClient = new BridgeClient({ ...settings, autoStart: false });
    this.expectedIdentity = bridgeIdentityFor(settings.bridgeCliPath) ?? null;
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
      expectedVersion: this.expectedIdentity?.version ?? bundledBridgeVersion(),
      identityMatch: null,
      bridgeName: this.lastPairing?.bridgeName ?? null,
      deviceUrl: null,
      socketPath: this.settings.socketPath,
      projectRoot: null,
      nsh: null,
      install: null,
      capabilities: [],
      error: null,
    };
    let devices: DeviceView[] = [];
    let devicesRead = false;
    let deployments: DeploymentView[] = [];

    try {
      const health = recordOf(await this.client.get('/v1/health'), 'health');
      const install = health.install !== null && typeof health.install === 'object' && !Array.isArray(health.install)
        ? health.install as Record<string, unknown>
        : null;
      const installPath = install !== null && typeof install.packageRoot === 'string'
        ? install.packageRoot
        : install !== null && typeof install.path === 'string' ? install.path : null;
      const installHash = install !== null && typeof install.packageHash === 'string' ? install.packageHash : null;
      const identityMatch = installPath !== null && this.expectedIdentity !== null
        ? installPath === this.expectedIdentity.packageRoot && installHash === this.expectedIdentity.packageHash
        : null;
      bridge = {
        available: true,
        version: typeof health.version === 'string' ? health.version : null,
        expectedVersion: this.expectedIdentity?.version ?? bundledBridgeVersion(),
        identityMatch,
        bridgeName: this.lastPairing?.bridgeName ?? null,
        deviceUrl: typeof health.deviceUrl === 'string' ? health.deviceUrl : null,
        socketPath: typeof health.socket === 'string' ? health.socket : this.settings.socketPath,
        projectRoot: typeof health.projectRoot === 'string' ? health.projectRoot : null,
        nsh: typeof health.nsh === 'string'
          ? { path: health.nsh, version: typeof health.nshVersion === 'string' ? health.nshVersion : null }
          : null,
        install: installPath === null ? null : {
          path: installPath,
          version: install !== null && typeof install.version === 'string' ? install.version : null,
          hash: installHash,
        },
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
        devicesRead = true;
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
      pairing: await this.currentPairingView(devicesRead ? devices : undefined, bridge.bridgeName),
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
      const { devices } = await this.devices();
      return { ok: true, pairing: durablePairingView(devices) };
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
      this.lastPairing = null;
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

  /**
   * Project the global pairing state after a Host/plugin reload. `devices` is
   * undefined when the registry could not be read; an empty array is an
   * authoritative empty registry. A waiting QR remains an explicit operation,
   * but stale QR state never hides a still-paired durable device.
   */
  private async currentPairingView(devices?: DeviceView[], bridgeName: string | null = null): Promise<PairingView> {
    const remembered = this.lastPairing;
    const durable = devices === undefined
      ? null
      : durablePairingView(devices, bridgeName ?? remembered?.bridgeName ?? null);
    if (remembered === null) return durable ?? durablePairingView([], bridgeName);
    try {
      const { pairing } = await this.pairingStatus({ sessionId: remembered.payload.sessionId });
      if (devices === undefined || pairing.state === 'waiting') return pairing;
      const stillPaired = pairing.state === 'paired' && pairing.deviceId !== null
        && devices.some((device) => device.deviceId === pairing.deviceId);
      if (stillPaired) return { ...pairing, bridgeName: pairing.bridgeName ?? bridgeName };
      if (pairing.state === 'expired' && devices.length === 0) return pairing;
      return durable ?? durablePairingView(devices, bridgeName ?? remembered.bridgeName);
    } catch {
      if (durable !== null && devices !== undefined && devices.length > 0) return durable;
      return {
        payload: remembered.payload,
        state: 'expired',
        deviceId: null,
        bridgeName: remembered.bridgeName,
        expiresAt: remembered.payload.expiresAt,
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

  /**
   * Discover/bind/launch lifecycle targets, or recover one paired device.
   * `list` returns the same device schema as the former `miniapp_devices`, enriched with
   * CoreDevice pairing, Host presence/version, binding and one next action.
   */
  async device(args: unknown): Promise<Record<string, unknown>> {
    const request = parseDeviceOperationArgs(args);
    if (request.action === 'list') return this.deviceList();
    if (request.action === 'launch_host') {
      return this.launchHost(request.deviceId, request.hostDeviceId, request.rebind, request.waitMs);
    }
    return this.ensureReady({
      deviceId: request.deviceId as string,
      hostDeviceId: request.hostDeviceId,
      rebind: request.rebind,
      waitMs: request.waitMs,
    });
  }

  /** One schema for both the devices tool and the device list action. */
  async deviceList(): Promise<Record<string, unknown>> {
    const warnings: string[] = [];
    let devices: DeviceView[] = [];
    let targets: HostDeviceTarget[] = [];
    let bindings: Array<{ deviceId: string; hostDeviceId: string; kind: string; name: string; boundAt: string }> = [];
    const [paired, discovered] = await Promise.allSettled([this.devices(), this.deviceHost.listTargets()]);
    if (paired.status === 'fulfilled') devices = paired.value.devices;
    else warnings.push(`paired devices could not be read: ${failureMessage(paired.reason)}`);
    if (discovered.status === 'fulfilled') targets = discovered.value;
    else warnings.push(`CoreDevice targets could not be read: ${failureMessage(discovered.reason)}`);
    try {
      bindings = this.deviceHost.listBindings();
    } catch (error) {
      warnings.push(`host bindings could not be read: ${failureMessage(error)}`);
    }
    if (paired.status === 'rejected' && discovered.status === 'rejected') {
      throw paired.reason instanceof Error ? paired.reason : new JieZiError('bridge_protocol', 'device discovery failed');
    }
    const enriched = devices.map((device) => enrichDevice(device, targets, bindings));
    return { ok: true, devices: enriched, targets, bindings, warnings };
  }

  /** Launch the installed Host without requiring a paired `deviceId` first. */
  async launchHost(
    deviceId: string | undefined,
    hostDeviceId: string | undefined,
    rebind: boolean,
    waitMs: number,
  ): Promise<Record<string, unknown>> {
    const targets = await this.deviceHost.listTargets();
    if (deviceId !== undefined) {
      const device = await this.pairedDevice(deviceId);
      const resolved = await this.deviceHost.resolveBinding({
        deviceId,
        deviceName: device.name,
        targetKind: device.targetKind,
        ...(hostDeviceId === undefined ? {} : { hostDeviceId }),
        rebind,
      });
      await this.deviceHost.launch(resolved.target);
      const deadline = Date.now() + waitMs;
      let latest = device;
      while (Date.now() < deadline) {
        await sleep(500);
        latest = await this.pairedDevice(deviceId);
        if (latest.online) break;
      }
      const enriched = enrichDevice(latest, targets, this.deviceHost.listBindings());
      return {
        ok: true,
        state: latest.online ? (isAutomationReady(latest) ? 'ready' : 'connected') : 'launched',
        deviceId,
        hostDeviceId: resolved.target.hostDeviceId,
        target: resolved.target,
        device: enriched,
        launched: true,
        nextAction: enriched.nextAction ?? 'Call miniapp with action=\"device\", deviceAction=\"ensure_ready\" if automation is still off.',
      };
    }

    let target: HostDeviceTarget | undefined;
    if (hostDeviceId !== undefined) {
      target = targets.find((item) => item.hostDeviceId === hostDeviceId);
      if (target === undefined) {
        throw new JieZiError('host_binding_required', `Unknown CoreDevice target: ${hostDeviceId}`, { retryable: false });
      }
    } else {
      const eligible = targets.filter((item) => item.kind === 'physical'
        ? item.paired
        : item.connected || item.state.toLowerCase() === 'booted');
      if (eligible.length === 1) target = eligible[0];
      else {
        const candidates = (eligible.length > 0 ? eligible : targets).slice(0, 8)
          .map((item) => `${item.name} [${item.kind}:${item.hostDeviceId}]`).join(', ');
        throw new JieZiError(
          'host_binding_required',
          `Pass hostDeviceId to launch the Host. Candidates: ${candidates || 'none'}`,
          { retryable: false },
        );
      }
    }
    await this.deviceHost.launch(target);
    return {
      ok: true,
      state: 'launched',
      hostDeviceId: target.hostDeviceId,
      target,
      nextAction: 'Pair the phone through the sidebar QR if no JieZi device is listed, then call miniapp with action=\"device\".',
    };
  }

  /** Host version and compatibility for one paired device, never throwing. */
  async hostInfo(deviceId: string): Promise<HostInfo> {
    try {
      const result = await this.devices();
      const device = result.devices.find((item) => item.deviceId === deviceId);
      if (device !== undefined) return hostOf(device);
    } catch {
      // A status/diagnostic call should still return its primary record.
    }
    return {
      deviceId,
      version: null,
      minimumVersion: MIN_HOST_VERSION,
      compatibility: 'unknown',
    };
  }

  /** Restart the configured bridge, used by the panel and the doctor action. */
  async restartBridge(): Promise<Record<string, unknown>> {
    if (this.bridgeSupervisor === null) {
      throw new JieZiError(
        'unsupported',
        'This profile runs jiezi-bridge without supervision (autoStart is off); restart it manually and retry.',
        { retryable: false },
      );
    }
    await this.bridgeSupervisor.restart();
    return {
      ok: true,
      restarted: true,
      socketPath: this.settings.socketPath,
      expectedVersion: this.expectedIdentity?.version ?? bundledBridgeVersion(),
    };
  }

  /** Apply the one safe doctor repair, then report again. */
  async repairToolchain(): Promise<SetupReport> {
    return repairSetup(this.settings);
  }

  /**
   * One-call readiness report for the Agent: bridge identity, toolchain, Host
   * version, pairing, and automation. `fix` only rewrites a stale nsh path and
   * restarts a stale bridge; it never initializes trust, pairs, or launches.
   */
  async doctor(args: unknown = {}): Promise<Record<string, unknown>> {
    const value = args !== null && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    const fix = value.fix === true;
    const blockers: Array<{ code: string; message: string; action: string }> = [];
    const nextActions: string[] = [];
    let setup: SetupReport | null = null;
    let setupError: string | null = null;
    try {
      setup = fix ? await repairSetup(this.settings) : await inspectSetup(this.settings);
    } catch (error) {
      setupError = failureMessage(error);
    }

    let health: Record<string, unknown> | null = null;
    let healthError: string | null = null;
    try {
      health = recordOf(await this.probeClient.get('/v1/health'), 'health');
    } catch (error) {
      healthError = failureMessage(error);
    }
    let install = health?.install !== null && health?.install !== undefined
      && typeof health.install === 'object' && !Array.isArray(health.install)
      ? health.install as Record<string, unknown>
      : null;
    let runningRoot = install !== null && typeof install.packageRoot === 'string' ? install.packageRoot : null;
    let runningHash = install !== null && typeof install.packageHash === 'string' ? install.packageHash : null;
    let identityMatch = runningRoot !== null && this.expectedIdentity !== null
      ? runningRoot === this.expectedIdentity.packageRoot && runningHash === this.expectedIdentity.packageHash
      : null;
    if (fix && (health === null || identityMatch === false || setup?.fixed === true)) {
      try {
        await this.restartBridge();
        health = recordOf(await this.probeClient.get('/v1/health'), 'health');
        healthError = null;
        install = health.install !== null && health.install !== undefined
          && typeof health.install === 'object' && !Array.isArray(health.install)
          ? health.install as Record<string, unknown>
          : null;
        runningRoot = install !== null && typeof install.packageRoot === 'string' ? install.packageRoot : null;
        runningHash = install !== null && typeof install.packageHash === 'string' ? install.packageHash : null;
        identityMatch = runningRoot !== null && this.expectedIdentity !== null
          ? runningRoot === this.expectedIdentity.packageRoot && runningHash === this.expectedIdentity.packageHash
          : null;
        nextActions.push('Restarted the bridge as part of the fix; the report below is from the new process.');
      } catch (error) {
        blockers.push({ code: 'bridge', message: failureMessage(error), action: 'Start the bridge from the JieZi panel.' });
      }
    }
    if (health === null) {
      blockers.push({
        code: 'bridge',
        message: healthError ?? 'jiezi-bridge is not running',
        action: 'Open the JieZi sidebar and press 重启桥接, or start jiezi-bridge manually.',
      });
    } else if (identityMatch === false) {
      blockers.push({
        code: 'bridge_identity',
        message: 'The running bridge does not match this plugin installation.',
        action: 'Press 重启桥接 in the JieZi panel; do not reuse the old process.',
      });
    }

    const nsh = setup?.nsh ?? null;
    if (setupError !== null) {
      blockers.push({ code: 'setup', message: setupError, action: 'Reinstall the plugin bundle or run the setup check again.' });
    } else if (nsh === null || !nsh.found) {
      blockers.push({
        code: 'nsh',
        message: nsh?.error ?? 'nsh was not found',
        action: fix ? 'Install jiezi-nsh or pass an explicit nshPath.' : 'Call miniapp with action=\"doctor\", fix:true, then restart the bridge.',
      });
    }

    let devices: DeviceView[] = [];
    let targets: HostDeviceTarget[] = [];
    let discoveryWarnings: string[] = [];
    try {
      const listed = await this.deviceList();
      devices = Array.isArray(listed.devices) ? listed.devices as DeviceView[] : [];
      targets = Array.isArray(listed.targets) ? listed.targets as HostDeviceTarget[] : [];
      discoveryWarnings = Array.isArray(listed.warnings) ? listed.warnings.filter((item): item is string => typeof item === 'string') : [];
    } catch (error) {
      discoveryWarnings.push(failureMessage(error));
    }
    const hosts = devices.map(hostOf);
    const outdated = hosts.filter((host) => host.compatibility === 'outdated');
    const warnings: string[] = [];
    if (outdated.length > 0) {
      const text = `Update the JieZi Host App on ${outdated.map((host) => host.deviceId).join(', ')} to ${MIN_HOST_VERSION} or newer; 0.1.x can raise the freeze-snapshot alert.`;
      warnings.push(text);
      nextActions.push(text);
    }
    if (devices.length === 0) {
      blockers.push({
        code: 'pairing',
        message: targets.length > 0 ? 'CoreDevice sees a phone, but no JieZi device is paired.' : 'No paired device and no CoreDevice target.',
        action: targets.length > 0
          ? 'Generate the sidebar QR and pair the phone; or launch the Host with miniapp action=\"device\", deviceAction=\"launch_host\".'
          : 'Connect and unlock the iPhone, open the JieZi Host App, then pair with the sidebar QR.',
      });
    } else if (!devices.some((device) => device.online)) {
      blockers.push({
        code: 'host_running',
        message: 'A device is paired but the Host is not connected.',
        action: 'Call miniapp with action=\"device\", deviceAction=\"launch_host\" and the paired deviceId.',
      });
    } else if (!devices.some((device) => device.online && device.developerMode && device.automation)) {
      blockers.push({
        code: 'automation',
        message: 'The Host is connected but developer automation is not ready.',
        action: 'Open developer mode and start automation on the phone; call miniapp with action=\"device\", deviceAction=\"ensure_ready\" to verify.',
      });
    }
    for (const device of devices) {
      if (device.nextAction !== null) nextActions.push(`${device.name}: ${device.nextAction}`);
    }
    nextActions.push(...discoveryWarnings);

    return {
      ok: true,
      ready: blockers.length === 0,
      bridge: health === null ? null : {
        running: true,
        version: typeof health.version === 'string' ? health.version : null,
        expectedVersion: this.expectedIdentity?.version ?? bundledBridgeVersion(),
        identityMatch,
        socketPath: typeof health.socket === 'string' ? health.socket : this.settings.socketPath,
        nsh: typeof health.nsh === 'string' ? health.nsh : null,
        pid: typeof health.pid === 'number' ? health.pid : null,
        startedAt: typeof health.startedAt === 'string' ? health.startedAt : null,
      },
      nsh,
      host: {
        minimumVersion: MIN_HOST_VERSION,
        devices: hosts,
      },
      pairing: await this.currentPairingView(devices),
      setup,
      blockers,
      warnings,
      nextActions: nextActions.slice(0, 12),
      fixed: setup?.fixed ?? false,
      fixes: setup?.fixes ?? [],
      checkedAt: new Date().toISOString(),
    };
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

  /** Queue one release for one device; `force` starts a fresh install operation. */
  async deploy(args: unknown): Promise<Record<string, unknown>> {
    const request = parseDeployArgs(args);
    let readyDevice: DeviceView | null = null;
    if (this.settings.autoStart) {
      const ready = await this.ensureReady({ deviceId: request.deviceId });
      if (ready.device !== null && typeof ready.device === 'object' && !Array.isArray(ready.device)) {
        readyDevice = ready.device as DeviceView;
      }
    }
    const result = recordOf(
      await this.client.post('/v1/deploy', {
        deviceId: request.deviceId,
        releaseId: request.releaseId,
        ...(request.force ? { force: true } : {}),
      }),
      'deploy result',
    );
    if (typeof result.opId === 'string') {
      this.rememberDeployment(deploymentView({ ...result, deviceId: request.deviceId, releaseId: request.releaseId }));
    }
    const host: HostInfo = readyDevice === null
      ? { deviceId: request.deviceId, version: null, minimumVersion: MIN_HOST_VERSION, compatibility: 'unknown' }
      : hostOf(readyDevice);
    const warning = host.compatibility === 'outdated'
      ? `The JieZi Host App on ${request.deviceId} is ${host.version ?? 'unknown'} (minimum ${host.minimumVersion}). Its legacy freeze-snapshot path can block automation after deploy/open; updating the Host is safer than redeploying the mini-app.`
      : null;
    if (result.deduplicated === true && result.resent !== true) {
      return {
        ...result,
        host,
        ...(warning === null ? {} : { warning }),
        reinstalled: false,
        nextAction: 'The existing operation was not reinstalled. Use miniapp({ action: \"reload\" }) (or action=\"deploy\" with force:true) when a Host alert or stale instance is blocking automation.',
      };
    }
    return { ...result, host, ...(warning === null ? {} : { warning }), reinstalled: result.reinstalled !== false };
  }

  /**
   * Reinstall and relaunch the current release with a fresh operation id.
   * Omit releaseId to use the device's active release (or appId's installed
   * release). This is the supported way to clear a stuck instance or a Host
   * alert; the open action never restarts a running instance.
   */
  async reload(args: unknown): Promise<Record<string, unknown>> {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new JieZiError('invalid_request', 'arguments must be an object');
    }
    const value = args as Record<string, unknown>;
    const deviceId = requireString(value.deviceId, 'deviceId', 256);
    let releaseId: string | null = optionalString(value.releaseId, 'releaseId', 256) ?? null;
    const appId = optionalString(value.appId, 'appId', 128);
    if (releaseId === null) {
      const device = await this.pairedDevice(deviceId);
      const active = device.activeApp;
      const match = appId === undefined
        ? null
        : active?.installedApps.find((app) => app.appId === appId) ?? null;
      releaseId = appId === undefined
        ? active?.releaseId ?? null
        : match?.releaseId ?? null;
      if (releaseId === null || releaseId.length === 0) {
        throw new JieZiError(
          'unknown_release',
          appId === undefined
            ? 'No active release is known for this device; pass releaseId or open the app first.'
            : `Installed app ${appId} has no known release; pass releaseId.`,
          { retryable: false },
        );
      }
    }
    if (releaseId === null || releaseId.length === 0) {
      throw new JieZiError('unknown_release', 'No release is available to reload; pass releaseId.', { retryable: false });
    }
    const result = await this.deploy({ deviceId, releaseId, force: true });
    return { ...result, reload: true, releaseId };
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
        const opDeviceId = typeof op.op?.deviceId === 'string' ? op.op.deviceId : null;
        return {
          ok: false,
          code: 'evidence_pending',
          message: 'No evidence has arrived for this operation yet.',
          state: typeof op.op?.state === 'string' ? op.op.state : null,
          failureLayer: typeof op.op?.failureLayer === 'string' ? op.op.failureLayer : null,
          ...(opDeviceId === null ? {} : { host: await this.hostInfo(opDeviceId) }),
        };
      }
    }
    const result = recordOf(await this.client.get(`/v1/evidence/${encodeURIComponent(evidenceId)}`), 'evidence');
    if (typeof result.deviceId === 'string' && result.deviceId.length > 0) {
      return { ...result, host: await this.hostInfo(result.deviceId) };
    }
    return result;
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
      host: await this.hostInfo(request.deviceId),
      note: 'open never restarts a running instance; use miniapp({ action: \"reload\" }) when a Host alert or stale instance blocks automation.',
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
    const rawHostAlert = automationAlert(current.hostAlert);
    // The legacy Host message says "deploy a fixed version", which is wrong for
    // a Host-layer alert. Keep the raw text but append the routing the Agent
    // should follow, so reading hostAlert directly cannot send it redeploying.
    const hostAlert = rawHostAlert === null
      ? null
      : { ...rawHostAlert, message: `${rawHostAlert.message}（宿主层问题；请更新宿主或清除弹窗，不要重复部署小程序。）` };
    let view = automationView(current, {
      requestId,
      opId: args.opId,
      deviceId: args.deviceId,
      action: args.action,
      appId: args.appId ?? hostAlert?.appId ?? null,
      instanceId: args.instanceId ?? hostAlert?.instanceId ?? null,
    });
    if (view.appId === null) view = { ...view, appId: args.appId ?? hostAlert?.appId ?? null };
    if (view.instanceId === null) view = { ...view, instanceId: args.instanceId ?? hostAlert?.instanceId ?? null };
    const verification = evaluateExpectation(args.expect, snapshot);
    const diagnostics = automationDiagnostics(current.diagnostics);
    const runtimeError = newestError(diagnostics);
    const host = await this.hostInfo(args.deviceId);
    let error = current.error === null || current.error === undefined
      ? null
      : {
          code: typeof (current.error as Record<string, unknown>).code === 'string'
            ? ((current.error as Record<string, unknown>).code as string).slice(0, 64)
            : 'unknown',
          message: typeof (current.error as Record<string, unknown>).message === 'string'
            ? ((current.error as Record<string, unknown>).message as string).slice(0, 500)
            : 'automation failed',
          category: 'device' as 'device' | 'host' | 'runtime' | 'verification',
        };
    if (error === null && view.state === 'done' && !verification.passed) {
      error = {
        code: 'expectation_failed',
        message: verification.reason ?? '动作后的页面没有满足期望',
        category: 'verification',
      };
    }
    if (error !== null && error.code === 'HOST_ALERT_BLOCKING') {
      const raw = hostAlert?.message ?? error.message;
      const freeze = /冻结|快照|freeze|snapshot/iu.test(raw);
      const version = host.version ?? 'unknown';
      error = {
        code: 'HOST_ALERT_BLOCKING',
        message: [
          `宿主 App 弹窗阻挡了自动化：${raw}`,
          freeze
            ? `这是宿主 App ${version} 的旧版冻结快照缺陷，不是小程序构建或运行时错误。不要重复部署同一个 release。`
            : '这是宿主 App 界面层的问题，不是小程序运行时错误。',
          `请更新宿主 App（当前 ${version}，最低 ${host.minimumVersion}），或在手机上点“继续/关闭”后重试。`,
        ].join(''),
        category: 'host',
      };
    }
    if (error !== null && view.state === 'done') {
      view = { ...view, state: 'failed', error: { code: error.code, message: error.message } };
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
      outline: snapshot === null ? null : formatOutline(snapshot, {
        frames: args.includeFrames === true,
        visibleOnly: args.includeHidden !== true,
      }),
      error,
      verification,
      diagnostics,
      diagnosticCursor: diagnostics?.cursor ?? null,
      hostAlert,
      host,
      runtimeError,
      deduplicated: started.deduplicated === true,
      snapshotIssues: {
        visibleNodeCount: snapshot?.visibleNodeCount ?? 0,
        hiddenNodeCount: snapshot?.hiddenNodeCount ?? 0,
        duplicateTestIDs: snapshot?.duplicateTestIDs ?? [],
      },
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

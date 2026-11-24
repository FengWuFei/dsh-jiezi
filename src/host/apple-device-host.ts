/**
 * Narrow Apple device lifecycle adapter for the one-pairing loop (017).
 *
 * The argument construction and bounded CoreDevice handling follow sim-use's
 * DevicectlQuery/SimctlDeviceLister patterns. sim-use remains the UI-driving
 * tool; this service only discovers targets and launches the JieZi host. No
 * arbitrary executable, argv, bundle id, terminate, uninstall or erase input is
 * accepted.
 */

import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JieZiError } from '../shared/errors.js';

export const JIEZI_HOST_BUNDLE_ID = 'com.jiezi.minihost';
const MAX_TARGETS = 100;
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;

export type HostDeviceKind = 'physical' | 'simulator';

export interface HostDeviceTarget {
  hostDeviceId: string;
  kind: HostDeviceKind;
  name: string;
  model: string | null;
  runtime: string | null;
  state: string;
  connected: boolean;
  paired: boolean;
  developerMode: boolean;
}

export interface HostDeviceBinding {
  deviceId: string;
  hostDeviceId: string;
  kind: HostDeviceKind;
  name: string;
  boundAt: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: readonly string[], timeoutMs?: number) => Promise<CommandResult>;

export interface ResolveBindingRequest {
  deviceId: string;
  deviceName: string;
  targetKind: HostDeviceKind | null;
  hostDeviceId?: string;
  rebind?: boolean;
}

export interface ResolvedHostBinding {
  binding: HostDeviceBinding;
  target: HostDeviceTarget;
}

/** Small interface consumed by operations; tests can provide an in-memory double. */
export interface DeviceHost {
  listTargets(): Promise<HostDeviceTarget[]>;
  listBindings(): HostDeviceBinding[];
  resolveBinding(request: ResolveBindingRequest): Promise<ResolvedHostBinding>;
  launch(target: HostDeviceTarget): Promise<void>;
  captureScreen(target: HostDeviceTarget, destination: string): Promise<void>;
  removeBinding(deviceId: string): void;
}

/** Execute only /usr/bin/xcrun with a fixed argument vector and bounded output. */
export const xcrunRunner: CommandRunner = (args, timeoutMs = 30_000) => new Promise((resolve, reject) => {
  execFile('/usr/bin/xcrun', [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error && (error.killed || error.signal || typeof error.code === 'string')) {
      reject(new JieZiError('host_launch_failed', `xcrun failed: ${error.message.slice(0, 500)}`));
      return;
    }
    resolve({
      code: typeof error?.code === 'number' ? error.code : 0,
      stdout: String(stdout),
      stderr: String(stderr),
    });
  });
});

export class AppleDeviceHost implements DeviceHost {
  private readonly bindingsPath: string;

  constructor(
    stateDir: string,
    private readonly runner: CommandRunner = xcrunRunner,
  ) {
    this.bindingsPath = join(stateDir, 'host-device-bindings.json');
  }

  async listTargets(): Promise<HostDeviceTarget[]> {
    const result = await this.runner([
      'devicectl', 'list', 'devices', '--omit-deprecated-fields-in-json', '--json-output', '-',
    ]);
    let document: unknown;
    try {
      document = JSON.parse(result.stdout);
    } catch {
      document = undefined;
    }
    if (document === undefined || (result.code !== 0 && isUnknownOption(result))) {
      // Older devicectl versions may not support omitting deprecated fields.
      const fallback = await this.runner(['devicectl', 'list', 'devices', '--json-output', '-']);
      try {
        document = JSON.parse(fallback.stdout);
      } catch {
        throw new JieZiError('host_launch_failed', `devicectl returned no readable device inventory: ${bounded(fallback.stderr || result.stderr)}`);
      }
      return parseDevicectlDevices(document).slice(0, MAX_TARGETS);
    }
    return parseDevicectlDevices(document).slice(0, MAX_TARGETS);
  }

  listBindings(): HostDeviceBinding[] {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.bindingsPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new JieZiError('bridge_protocol', `Cannot read host-device bindings: ${error instanceof Error ? error.message : String(error)}`, { retryable: false });
    }
    const envelope = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const rows = envelope?.bindings;
    if (envelope?.schemaVersion !== 1 || !Array.isArray(rows) || rows.length > 50
      || Object.keys(envelope).sort().join(',') !== 'bindings,schemaVersion') {
      throw new JieZiError('bridge_protocol', 'Host-device bindings have an invalid schema or row count.', { retryable: false });
    }
    return rows.map((row, index) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new JieZiError('bridge_protocol', `Host-device binding row ${index} is not an object.`, { retryable: false });
      }
      const item = row as Record<string, unknown>;
      if (Object.keys(item).sort().join(',') !== 'boundAt,deviceId,hostDeviceId,kind,name') {
        throw new JieZiError('bridge_protocol', `Host-device binding row ${index} has unknown fields.`, { retryable: false });
      }
      const kind: HostDeviceKind | null = item.kind === 'physical' || item.kind === 'simulator' ? item.kind : null;
      if (typeof item.deviceId !== 'string' || item.deviceId.length === 0 || item.deviceId.length > 128
        || typeof item.hostDeviceId !== 'string' || item.hostDeviceId.length === 0 || item.hostDeviceId.length > 128
        || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 128
        || typeof item.boundAt !== 'string' || item.boundAt.length === 0 || item.boundAt.length > 64
        || kind === null) {
        throw new JieZiError('bridge_protocol', `Host-device binding row ${index} is malformed.`, { retryable: false });
      }
      return {
        deviceId: item.deviceId,
        hostDeviceId: item.hostDeviceId,
        kind,
        name: item.name,
        boundAt: item.boundAt,
      };
    });
  }

  async resolveBinding(request: ResolveBindingRequest): Promise<ResolvedHostBinding> {
    const targets = await this.listTargets();
    const existing = this.listBindings().find((item) => item.deviceId === request.deviceId) ?? null;
    if (existing && request.hostDeviceId === undefined) {
      const target = targets.find((item) => item.hostDeviceId === existing.hostDeviceId);
      if (!target) {
        throw new JieZiError('device_offline', `The bound host device ${existing.name} (${existing.hostDeviceId}) is not visible to CoreDevice.`);
      }
      return { binding: existing, target };
    }
    if (existing && request.hostDeviceId !== existing.hostDeviceId && request.rebind !== true) {
      throw new JieZiError(
        'host_binding_required',
        `${request.deviceId} is already bound to ${existing.hostDeviceId}; pass rebind:true to replace that explicit binding.`,
        { retryable: false },
      );
    }

    let target: HostDeviceTarget | undefined;
    if (request.hostDeviceId !== undefined) {
      target = targets.find((item) => item.hostDeviceId === request.hostDeviceId);
      if (!target) throw new JieZiError('host_binding_required', `Unknown CoreDevice target: ${request.hostDeviceId}`, { retryable: false });
    } else {
      const kindMatches = request.targetKind === null ? targets : targets.filter((item) => item.kind === request.targetKind);
      const eligible = kindMatches.filter((item) => item.kind === 'physical'
        ? item.paired
        : item.state.toLowerCase() === 'booted');
      const normalizedName = normalizeName(request.deviceName);
      const nameMatches = eligible.filter((item) => normalizeName(item.name) === normalizedName);
      if (nameMatches.length === 1) target = nameMatches[0];
      else if (nameMatches.length === 0 && eligible.length === 1) target = eligible[0];
      else {
        const candidates = (nameMatches.length > 0 ? nameMatches : eligible)
          .slice(0, 8)
          .map((item) => `${item.name} [${item.kind}:${item.hostDeviceId}]`)
          .join(', ');
        throw new JieZiError(
          'host_binding_required',
          `Select the host UDID once with miniapp({ action: "device", deviceAction: "ensure_ready", hostDeviceId }). Candidates: ${candidates || 'none'}`,
          { retryable: false },
        );
      }
    }
    if (request.targetKind !== null && target.kind !== request.targetKind) {
      throw new JieZiError('host_binding_required', `Target kind ${target.kind} does not match the paired ${request.targetKind} device.`, { retryable: false });
    }

    const binding: HostDeviceBinding = {
      deviceId: request.deviceId,
      hostDeviceId: target.hostDeviceId,
      kind: target.kind,
      name: target.name,
      boundAt: new Date().toISOString(),
    };
    this.saveBinding(binding);
    return { binding, target };
  }

  async launch(target: HostDeviceTarget): Promise<void> {
    if (target.kind === 'simulator') {
      if (target.state.toLowerCase() !== 'booted') {
        await requireSuccess(await this.runner(['simctl', 'boot', target.hostDeviceId]), 'simulator boot');
        await requireSuccess(await this.runner(['simctl', 'bootstatus', target.hostDeviceId, '-b'], 60_000), 'simulator bootstatus');
      }
      const launched = await this.runner(['simctl', 'launch', target.hostDeviceId, JIEZI_HOST_BUNDLE_ID]);
      if (launched.code !== 0 && !/already running/i.test(launched.stderr)) {
        throw launchFailure('simctl launch', launched);
      }
      return;
    }
    const launched = await this.runner([
      'devicectl', 'device', 'process', 'launch',
      '--device', target.hostDeviceId,
      '--activate', '--timeout', '25', '--json-output', '-',
      JIEZI_HOST_BUNDLE_ID,
    ], 35_000);
    if ((launched.code === 0 && !hasFailedOutcome(launched.stdout)) || /already running/i.test(launched.stderr)) return;
    throw launchFailure('devicectl process launch', launched);
  }

  /** Capture the whole device screen to a PNG. Explicit developer evidence only. */
  async captureScreen(target: HostDeviceTarget, destination: string): Promise<void> {
    if (!destination.endsWith('.png')) {
      throw new JieZiError('screen_capture_failed', 'screen destination must be a .png path', { retryable: false });
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const args = target.kind === 'simulator'
      ? ['simctl', 'io', target.hostDeviceId, 'screenshot', destination]
      : ['devicectl', 'device', 'capture', 'screenshot', '--device', target.hostDeviceId, '--destination', destination];
    const result = await this.runner(args, 30_000);
    if (result.code !== 0) {
      throw new JieZiError(
        'screen_capture_failed',
        `xcrun ${target.kind === 'simulator' ? 'simctl io' : 'devicectl capture'} failed: ${bounded(result.stderr || result.stdout)}`,
        { retryable: true },
      );
    }
    chmodSync(destination, 0o600);
  }

  removeBinding(deviceId: string): void {
    const bindings = this.listBindings().filter((item) => item.deviceId !== deviceId);
    this.writeBindings(bindings);
  }

  private saveBinding(binding: HostDeviceBinding): void {
    const bindings = this.listBindings().filter((item) => item.deviceId !== binding.deviceId);
    bindings.push(binding);
    this.writeBindings(bindings);
  }

  private writeBindings(bindings: HostDeviceBinding[]): void {
    mkdirSync(dirname(this.bindingsPath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.bindingsPath), 0o700); } catch { /* best effort on non-POSIX */ }
    const temporary = `${this.bindingsPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, bindings }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.bindingsPath);
  }
}

/** Parse current `properties` and the legacy fields seen in Xcode 26/27 output. */
export function parseDevicectlDevices(value: unknown): HostDeviceTarget[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JieZiError('host_launch_failed', 'devicectl inventory is not a JSON object.');
  }
  const envelope = value as Record<string, unknown>;
  const outcome = envelope.info !== null && typeof envelope.info === 'object' && !Array.isArray(envelope.info)
    ? (envelope.info as Record<string, unknown>).outcome
    : undefined;
  if (outcome !== undefined && outcome !== 'success') {
    throw new JieZiError('host_launch_failed', `devicectl inventory failed: ${bounded(JSON.stringify(envelope.error ?? outcome))}`);
  }
  const result = envelope.result !== null && typeof envelope.result === 'object' && !Array.isArray(envelope.result)
    ? envelope.result as Record<string, unknown>
    : {};
  const rows = Array.isArray(result.devices) ? result.devices : [];
  const targets: HostDeviceTarget[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const properties = record(item.properties);
    const hardware = { ...record(item.hardwareProperties), ...record(properties.hardware) };
    const software = { ...record(item.deviceProperties), ...record(properties.software) };
    const state = { ...record(item.deviceProperties), ...record(properties.state) };
    const connection = { ...record(item.connectionProperties), ...record(properties.connection) };
    if (text(hardware.platform) !== 'iOS') continue;
    const reality = text(hardware.reality);
    const kind: HostDeviceKind | null = reality === 'physical' ? 'physical' : reality === 'simulated' ? 'simulator' : null;
    const hostDeviceId = text(hardware.udid) || text(item.identifier);
    if (kind === null || !hostDeviceId) continue;
    const developerValue = state.developerModeStatus;
    targets.push({
      hostDeviceId: hostDeviceId.slice(0, 128),
      kind,
      name: (text(state.name) || 'Apple device').slice(0, 128),
      model: nullableText(hardware.marketingName ?? hardware.productType),
      runtime: versionText(software.osVersionNumber),
      state: (text(state.bootState) || 'unknown').slice(0, 32),
      connected: text(connection.state) === 'connected' || text(connection.tunnelState) === 'connected',
      paired: text(connection.pairingState) === 'paired',
      developerMode: typeof developerValue === 'string'
        ? developerValue === 'enabled'
        : developerValue !== null && typeof developerValue === 'object' && !Array.isArray(developerValue)
          ? Object.keys(developerValue as Record<string, unknown>).includes('enabled')
          : false,
    });
  }
  return targets.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.hostDeviceId.localeCompare(b.hostDeviceId));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  const result = text(value);
  return result ? result.slice(0, 128) : null;
}

function versionText(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 64);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return nullableText((value as Record<string, unknown>).stringValue);
  }
  return null;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function bounded(value: string, max = 500): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, max);
}

function isUnknownOption(result: CommandResult): boolean {
  return /unrecognized|unknown (subcommand|option|argument)|unexpected argument/iu.test(`${result.stderr}\n${result.stdout}`);
}

function requireSuccess(result: CommandResult, operation: string): CommandResult {
  if (result.code !== 0) throw launchFailure(operation, result);
  return result;
}

function hasFailedOutcome(stdout: string): boolean {
  try {
    const document = JSON.parse(stdout) as Record<string, unknown>;
    const info = record(document.info);
    return typeof info.outcome === 'string' && info.outcome !== 'success';
  } catch {
    return false;
  }
}

function launchFailure(operation: string, result: CommandResult): JieZiError {
  let detail = result.stderr;
  try {
    const document = JSON.parse(result.stdout) as Record<string, unknown>;
    detail = JSON.stringify(document.error ?? document.info ?? detail);
  } catch {
    if (!detail) detail = result.stdout;
  }
  return new JieZiError(
    'host_launch_failed',
    `${operation} failed (exit ${result.code}): ${bounded(detail) || 'no diagnostic output'}. Ensure the JieZi host is installed, the device is unlocked/trusted, and iOS Developer Mode is enabled.`,
  );
}

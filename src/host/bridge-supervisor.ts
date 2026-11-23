/**
 * Process supervisor for the existing standalone jiezi-bridge (017).
 *
 * It can only `serve` an already-initialized state directory. It never runs
 * `init`, creates trust material, or handles a pairing token. A spawned bridge
 * deliberately outlives plugin HMR; tests can stop only their owned child.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { JieZiError } from '../shared/errors.js';
import { BridgeClient, bundledBridgeVersion, type BridgeSettings } from './bridge-client.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Least-privilege child environment: no provider/pairing credential inheritance. */
export function supervisedBridgeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'DEVELOPER_DIR',
    'NSH', 'NSH_TOOLING', 'NSH_TOOLCHAIN', 'CARGO_HOME', 'RUSTUP_HOME',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) environment[key] = value;
  }
  environment.ELECTRON_RUN_AS_NODE = '1';
  return environment;
}

export class BridgeSupervisor {
  private readonly probeClient: BridgeClient;
  private readonly expectedVersion: string | null;
  private starting: Promise<void> | null = null;
  private ownedChild: ChildProcess | null = null;

  constructor(private readonly settings: BridgeSettings) {
    // Health probes must not recursively trigger the supervisor.
    this.probeClient = new BridgeClient({ ...settings, autoStart: false });
    this.expectedVersion = bundledBridgeVersion();
  }

  async ensureRunning(): Promise<void> {
    const health = await this.health();
    if (health.ok) {
      const expected = this.expectedVersion;
      if (expected === null || health.version === expected) return;
      if (this.ownedChild === null || this.ownedChild.exitCode !== null || this.ownedChild.signalCode !== null) {
        throw new JieZiError(
          'bridge_version_mismatch',
          `jiezi-bridge ${health.version ?? 'unknown'} is already running at ${this.settings.socketPath}; this package bundles ${expected}. Stop that bridge and retry.`,
          { retryable: false },
        );
      }
      // A bridge this supervisor started may be replaced in place; never kill
      // a process owned by another DSH profile or a manual `serve`.
      await this.stopOwned();
    }
    if (this.starting === null) this.starting = this.startAndWait();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Stop only the child spawned by this instance; never kill a pre-existing bridge. */
  async stopOwned(): Promise<void> {
    const child = this.ownedChild;
    this.ownedChild = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3_000)]);
  }

  private async health(): Promise<{ ok: boolean; version: string | null }> {
    try {
      const value = await this.probeClient.get<Record<string, unknown>>('/v1/health');
      return { ok: true, version: typeof value.version === 'string' ? value.version : null };
    } catch {
      return { ok: false, version: null };
    }
  }

  private async startAndWait(): Promise<void> {
    if (!this.settings.autoStart) {
      throw new JieZiError('bridge_unavailable', `jiezi-bridge is not running at ${this.settings.socketPath}`);
    }
    const configPath = join(this.settings.stateDir, 'config.json');
    if (!existsSync(configPath)) {
      throw new JieZiError(
        'bridge_not_configured',
        `No initialized JieZi bridge exists at ${this.settings.stateDir}; complete the one-time bridge setup before pairing.`,
        { retryable: false },
      );
    }
    if (!existsSync(this.settings.bridgeCliPath)) {
      throw new JieZiError(
        'bridge_not_configured',
        `The configured jiezi-bridge CLI is unavailable: ${this.settings.bridgeCliPath}`,
        { retryable: false },
      );
    }

    mkdirSync(this.settings.stateDir, { recursive: true, mode: 0o700 });
    const logPath = join(this.settings.stateDir, 'bridge-service.log');
    const logFd = openSync(logPath, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.settings.bridgeCliPath, 'serve', '--state-dir', this.settings.stateDir], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: supervisedBridgeEnvironment(process.env),
      });
    } catch (error) {
      closeSync(logFd);
      throw new JieZiError('bridge_unavailable', `Could not spawn jiezi-bridge: ${error instanceof Error ? error.message : String(error)}`);
    }
    closeSync(logFd);
    this.ownedChild = child;
    child.unref();

    const deadline = Date.now() + 15_000;
    let earlyFailure = '';
    child.once('error', (error) => { earlyFailure = error.message; });
    while (Date.now() < deadline) {
      if ((await this.health()).ok) return;
      if (earlyFailure || child.exitCode !== null || child.signalCode !== null) {
        this.ownedChild = null;
        throw new JieZiError(
          'bridge_unavailable',
          `jiezi-bridge exited during startup${earlyFailure ? `: ${earlyFailure}` : ` (code ${String(child.exitCode ?? child.signalCode)})`}. See ${logPath}`,
        );
      }
      await sleep(150);
    }
    this.ownedChild = null;
    child.kill('SIGTERM');
    throw new JieZiError('bridge_timeout', `jiezi-bridge did not become healthy within 15s. See ${logPath}`);
  }
}

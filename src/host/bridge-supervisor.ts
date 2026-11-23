/**
 * Process supervisor for the existing standalone jiezi-bridge (017).
 *
 * It can only `serve` an already-initialized state directory. It never runs
 * `init`, creates trust material, or handles a pairing token. A spawned bridge
 * deliberately outlives plugin HMR; tests can stop only their owned child.
 *
 * 030 adds identity, not just version: a plugin upgrade replaces `lib/bridge`
 * in place, so a process that started before the new files is stale even when
 * both copies report the same version. The supervisor restarts a process it
 * owns, a process whose reported install root is this package, or a process
 * whose command line names this exact CLI and state directory. Anything else
 * fails closed instead of killing another profile's bridge.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JieZiError } from '../shared/errors.js';
import {
  BridgeClient,
  bridgeIdentityFor,
  bundledBridgeIdentity,
  type BridgeIdentity,
  type BridgeSettings,
} from './bridge-client.js';

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

interface RunningBridge {
  ok: boolean;
  version: string | null;
  startedAt: string | null;
  pid: number | null;
  install: { packageRoot: string | null; packageHash: string | null; version: string | null } | null;
  nsh: string | null;
}

function installOf(value: unknown): RunningBridge['install'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    packageRoot: typeof record.packageRoot === 'string' ? record.packageRoot : typeof record.path === 'string' ? record.path : null,
    packageHash: typeof record.packageHash === 'string' ? record.packageHash : null,
    version: typeof record.version === 'string' ? record.version : null,
  };
}

export class BridgeSupervisor {
  private readonly probeClient: BridgeClient;
  private readonly expected: BridgeIdentity | null;
  private starting: Promise<void> | null = null;
  private ensuring: Promise<void> | null = null;
  private ownedChild: ChildProcess | null = null;

  constructor(private readonly settings: BridgeSettings) {
    // Health probes must not recursively trigger the supervisor.
    this.probeClient = new BridgeClient({ ...settings, autoStart: false });
    this.expected = bridgeIdentityFor(settings.bridgeCliPath) ?? bundledBridgeIdentity();
  }

  /** The identity this supervisor considers current; exposed for status/doctor. */
  identity(): BridgeIdentity | null {
    return this.expected;
  }

  ensureRunning(): Promise<void> {
    if (this.ensuring === null) {
      this.ensuring = this.ensureOnce().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async ensureOnce(): Promise<void> {
    const health = await this.health();
    if (health.ok) {
      const reason = this.staleReason(health);
      if (reason === null) return;
      await this.replace(health, reason);
    } else if (this.ownedChild !== null && this.ownedChild.exitCode === null && this.ownedChild.signalCode === null) {
      // The probe failed but our child has not exited yet. Stop it before
      // spawning another process on the same socket.
      await this.stopOwned();
    }
    if (this.starting === null) this.starting = this.startAndWait();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Force a restart even when the running bridge looks current. */
  async restart(): Promise<void> {
    const health = await this.health();
    if (health.ok) {
      if (this.ownedChild !== null && this.ownedChild.exitCode === null && this.ownedChild.signalCode === null) {
        await this.stopOwned();
      } else {
        if (!(await this.mayStop(health))) {
          throw this.mismatchError(health, 'an explicit restart was requested but this process is not provably owned by this plugin installation');
        }
        await this.stopRunning(health);
      }
    } else {
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exited, sleep(1_000)]);
  }

  /** A running bridge is current only when identity and startup time agree. */
  private staleReason(health: RunningBridge): string | null {
    const expected = this.expected;
    if (expected === null) return null;
    if (health.version !== expected.version) {
      return `version ${health.version ?? 'unknown'} != ${expected.version}`;
    }
    const install = health.install;
    if (install?.packageRoot !== null && install?.packageRoot !== undefined
      && install.packageHash !== null && install.packageHash !== undefined) {
      if (install.packageRoot !== expected.packageRoot) {
        return `installed at ${install.packageRoot}, expected ${expected.packageRoot}`;
      }
      if (install.packageHash !== expected.packageHash) {
        return `source hash ${install.packageHash} != ${expected.packageHash}`;
      }
      return null;
    }
    // Legacy health (before 030) has no install identity. A process that
    // started before the newest bundled module was written is stale even when
    // the version string matches; this is the exact 0.3.3 in-place upgrade.
    if (health.startedAt !== null) {
      const started = Date.parse(health.startedAt);
      if (Number.isFinite(started) && started + 1_000 < expected.newestMtimeMs) {
        return `started ${health.startedAt} before bundled code ${new Date(expected.newestMtimeMs).toISOString()}`;
      }
    }
    return null;
  }

  private async replace(health: RunningBridge, reason: string): Promise<void> {
    if (this.ownedChild !== null && this.ownedChild.exitCode === null && this.ownedChild.signalCode === null) {
      await this.stopOwned();
      return;
    }
    if (!(await this.mayStop(health))) {
      throw this.mismatchError(health, reason);
    }
    await this.stopRunning(health);
  }

  /** Only an installed copy at our root, or the exact CLI+state process, is ours. */
  private async mayStop(health: RunningBridge): Promise<boolean> {
    if (this.expected !== null && health.install?.packageRoot === this.expected.packageRoot) return true;
    return this.processMatches(health.pid);
  }

  private async processMatches(pid: number | null): Promise<boolean> {
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
    if (process.platform === 'win32') return false;
    const ps = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
    if (!existsSync(ps)) return false;
    const command = await new Promise<string | null>((resolveCommand) => {
      execFile(ps, ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolveCommand(error === null ? String(stdout) : null);
      });
    });
    if (command === null) return false;
    let cli = this.settings.bridgeCliPath;
    try {
      cli = realpathSync(cli);
    } catch {
      // Keep the configured path when it cannot be resolved.
    }
    return command.includes(cli)
      && command.includes(resolve(this.settings.stateDir));
  }

  private async stopRunning(health: RunningBridge): Promise<void> {
    const pid = health.pid;
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
      throw this.mismatchError(health, 'the stale bridge did not report a PID');
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw this.mismatchError(health, `could not stop PID ${pid}: ${String(code ?? error)}`);
    }
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!(await this.health()).ok) return;
    }
    if (await this.processMatches(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // It may have exited between the check and the signal.
      }
      const killDeadline = Date.now() + 2_000;
      while (Date.now() < killDeadline) {
        await sleep(100);
        if (!(await this.health()).ok) return;
      }
    }
    throw new JieZiError(
      'bridge_timeout',
      `The stale jiezi-bridge process (PID ${pid}) did not stop. Stop it manually and retry.`,
    );
  }

  private mismatchError(health: RunningBridge, reason: string): JieZiError {
    const expected = this.expected;
    const running = health.install?.packageRoot ?? 'an unidentified installation';
    return new JieZiError(
      'bridge_identity_mismatch',
      `A jiezi-bridge is already running at ${this.settings.socketPath} but is not this package: ${reason}. Running: ${health.version ?? 'unknown'} at ${running}. Expected: ${expected?.version ?? 'unknown'} at ${expected?.packageRoot ?? this.settings.bridgeCliPath}. Restart it from the JieZi panel or stop PID ${health.pid ?? 'unknown'} and retry.`,
      { retryable: false },
    );
  }

  private async health(): Promise<RunningBridge> {
    try {
      const value = await this.probeClient.get<Record<string, unknown>>('/v1/health');
      return {
        ok: true,
        version: typeof value.version === 'string' ? value.version : null,
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
        pid: typeof value.pid === 'number' && Number.isSafeInteger(value.pid) ? value.pid : null,
        install: installOf(value.install),
        nsh: typeof value.nsh === 'string' ? value.nsh : null,
      };
    } catch {
      return { ok: false, version: null, startedAt: null, pid: null, install: null, nsh: null };
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

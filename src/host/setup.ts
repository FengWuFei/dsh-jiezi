/**
 * First-run inspection and explicit initialization for the bridge bundled in
 * this package.
 *
 * Activation never runs `init` (017): this module is reachable only from the
 * authenticated setup route, and only after this request carries
 * `consent: true`. It executes the packaged bridge CLI as a short-lived child;
 * the long-lived `serve` process stays owned by BridgeSupervisor.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JieZiError } from '../shared/errors.js';
import {
  parseSetupArgs,
  type SetupCheck,
  type SetupInitializeResult,
  type SetupReport,
} from '../shared/protocol.js';
import type { BridgeSettings } from './bridge-client.js';
import { supervisedBridgeEnvironment } from './bridge-supervisor.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
const DOCTOR_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 90_000;
const MAX_CHECK_MESSAGE = 500;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function checkOf(value: unknown): SetupCheck | null {
  const record = asObject(value);
  if (record === null || typeof record.id !== 'string') return null;
  return {
    id: record.id.slice(0, 64),
    ok: boolean(record.ok),
    message: (stringOrNull(record.message, MAX_CHECK_MESSAGE) ?? '').slice(0, MAX_CHECK_MESSAGE),
  };
}

function keysPresent(keysDir: string): boolean {
  try {
    return readdirSync(keysDir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

/** Parse the last JSON object printed by a CLI, tolerating log lines before it. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return asObject(JSON.parse(text.slice(start)));
  } catch {
    return null;
  }
}

function failureFor(error: Error & { code?: unknown }, stdout: string, stderr: string): JieZiError {
  const body = parseJsonObject(stdout) ?? parseJsonObject(stderr);
  const record = asObject(body?.error);
  const code = stringOrNull(record?.code, 64);
  const message = stringOrNull(record?.message, MAX_CHECK_MESSAGE)
    ?? (stderr.trim() || stdout.trim() || error.message).slice(-MAX_CHECK_MESSAGE);
  if (code === 'build_failed' && /\bnsh\b/i.test(message)) {
    return new JieZiError(
      'nsh_missing',
      `${message} Restart the bridge from the JieZi panel after fixing the toolchain; miniapp({ action: "doctor", fix: true }) can rewrite a stale configured path.`,
      { retryable: false },
    );
  }
  return new JieZiError('setup_failed', message, { retryable: false });
}

function runBridgeJson(cliPath: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: supervisedBridgeEnvironment(process.env),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(failureFor(error, String(stdout ?? ''), String(stderr ?? '')));
        return;
      }
      const value = parseJsonObject(String(stdout ?? ''));
      if (value === null) {
        reject(new JieZiError('setup_failed', 'jiezi-bridge returned no JSON report', { retryable: false }));
        return;
      }
      resolve(value);
    });
  });
}

function normalizeReport(raw: Record<string, unknown>, cliPath: string): SetupReport {
  const cli = asObject(raw.cli);
  const state = asObject(raw.state);
  const socket = asObject(raw.socket);
  const nsh = asObject(raw.nsh);
  const install = asObject(raw.install);
  const apple = asObject(raw.apple);
  const candidates = Array.isArray(nsh?.candidates)
    ? nsh.candidates.filter((entry): entry is string => typeof entry === 'string').slice(0, 12)
    : [];
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map(checkOf).filter((entry): entry is SetupCheck => entry !== null).slice(0, 12)
    : [];
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
    : [];
  return {
    ok: true,
    version: stringOrNull(raw.version, 64),
    platform: stringOrNull(raw.platform, 32) ?? process.platform,
    arch: stringOrNull(raw.arch, 32) ?? process.arch,
    node: stringOrNull(raw.node, 64) ?? process.version,
    cli: { path: stringOrNull(cli?.path, 2048) ?? cliPath, available: true },
    install: install === null ? null : {
      path: stringOrNull(install.path, 2048) ?? '',
      version: stringOrNull(install.version, 64),
      hash: stringOrNull(install.packageHash, 128),
    },
    state: {
      dir: stringOrNull(state?.dir, 2048) ?? '',
      initialized: boolean(state?.initialized),
      configPath: stringOrNull(state?.configPath, 2048) ?? '',
      keysPresent: boolean(state?.keysPresent),
    },
    socket: {
      path: stringOrNull(socket?.path, 2048) ?? '',
      running: boolean(socket?.running),
      version: stringOrNull(socket?.version, 64),
      startedAt: stringOrNull(socket?.startedAt, 64),
      identityMatch: typeof socket?.identityMatch === 'boolean' ? socket.identityMatch : null,
      stale: typeof socket?.stale === 'boolean' ? socket.stale : null,
      nsh: stringOrNull(socket?.nsh, 2048),
      error: stringOrNull(socket?.error, 2048),
    },
    nsh: {
      found: boolean(nsh?.found),
      configured: stringOrNull(nsh?.configured, 2048),
      path: stringOrNull(nsh?.path, 2048),
      version: stringOrNull(nsh?.version, 256),
      error: stringOrNull(nsh?.error, 2048),
      candidates,
      candidateCount: typeof nsh?.candidateCount === 'number' ? nsh.candidateCount : candidates.length,
    },
    apple: {
      devicectl: boolean(apple?.devicectl),
      simctl: boolean(apple?.simctl),
      note: stringOrNull(apple?.note, 1024),
    },
    checks,
    notes,
    ...(raw.fixed === undefined ? {} : { fixed: boolean(raw.fixed) }),
    ...(Array.isArray(raw.fixes)
      ? { fixes: raw.fixes.filter((entry): entry is string => typeof entry === 'string').slice(0, 8).map((entry) => entry.slice(0, 500)) }
      : {}),
    checkedAt: stringOrNull(raw.checkedAt, 64) ?? new Date().toISOString(),
  };
}

function missingCliReport(settings: BridgeSettings): SetupReport {
  const configPath = join(settings.stateDir, 'config.json');
  const initialized = existsSync(configPath);
  const keys = keysPresent(join(settings.stateDir, 'dev-keys'));
  const missing = `the packaged bridge CLI is missing at ${settings.bridgeCliPath}`;
  return {
    ok: true,
    version: null,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cli: { path: settings.bridgeCliPath, available: false },
    install: null,
    state: { dir: settings.stateDir, initialized, configPath, keysPresent: keys },
    socket: {
      path: settings.socketPath, running: false, version: null, startedAt: null,
      identityMatch: null, stale: null, nsh: null, error: missing,
    },
    nsh: {
      found: false, configured: null, path: null, version: null,
      error: 'not checked without the bridge CLI', candidates: [], candidateCount: 0,
    },
    apple: { devicectl: false, simctl: false, note: missing },
    checks: [
      { id: 'bridge-cli', ok: false, message: missing },
      { id: 'state', ok: initialized, message: initialized ? `initialized at ${settings.stateDir}` : `not initialized at ${settings.stateDir}` },
      { id: 'keys', ok: keys, message: keys ? 'development keys present' : 'no development keys' },
      { id: 'nsh', ok: false, message: 'not checked without the bridge CLI' },
      { id: 'socket', ok: false, message: missing },
    ],
    notes: ['Reinstall the bundle so lib/bridge is present, then retry setup.'],
    checkedAt: new Date().toISOString(),
  };
}

/** Read-only setup report; safe to call on every panel open. */
export async function inspectSetup(settings: BridgeSettings, options: { fix?: boolean } = {}): Promise<SetupReport> {
  if (!existsSync(settings.bridgeCliPath)) return missingCliReport(settings);
  try {
    const args = ['doctor', '--state-dir', settings.stateDir];
    if (options.fix === true) args.push('--fix');
    const raw = await runBridgeJson(
      settings.bridgeCliPath,
      args,
      DOCTOR_TIMEOUT_MS,
    );
    return normalizeReport(raw, settings.bridgeCliPath);
  } catch (error) {
    if (error instanceof JieZiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new JieZiError('setup_failed', message.slice(0, MAX_CHECK_MESSAGE), { retryable: false });
  }
}

/**
 * Apply the bridge's one safe repair (a stale nsh path) and return the report.
 * Trust material, pairing, and processes stay untouched; the caller decides
 * whether a bridge restart follows.
 */
export async function repairSetup(settings: BridgeSettings): Promise<SetupReport> {
  return inspectSetup(settings, { fix: true });
}

function summarizeInit(raw: Record<string, unknown>): NonNullable<SetupInitializeResult['init']> {
  const devKey = asObject(raw.devKey);
  const tls = asObject(raw.tls);
  return {
    stateDir: stringOrNull(raw.stateDir, 2048),
    socket: stringOrNull(raw.socket, 2048),
    projectRoot: stringOrNull(raw.projectRoot, 2048),
    nsh: stringOrNull(raw.nsh, 2048),
    devKey: devKey === null ? null : {
      keyId: stringOrNull(devKey.keyId, 128),
      path: stringOrNull(devKey.path, 2048),
    },
    tls: tls === null ? null : { fingerprint: stringOrNull(tls.fingerprint, 128) },
  };
}

/** Run bridge `init` once after explicit consent, then return its doctor report. */
export async function initializeSetup(settings: BridgeSettings, rawArgs: unknown): Promise<SetupInitializeResult> {
  const args = parseSetupArgs(rawArgs);
  if (existsSync(join(settings.stateDir, 'config.json'))) {
    return {
      ok: true,
      alreadyInitialized: true,
      host: args.host,
      tls: args.tls,
      init: null,
      report: await inspectSetup(settings),
    };
  }
  if (!existsSync(settings.bridgeCliPath)) {
    throw new JieZiError(
      'setup_failed',
      `the packaged bridge CLI is missing at ${settings.bridgeCliPath}; reinstall the bundle`,
      { retryable: false },
    );
  }
  const command = ['init', '--state-dir', settings.stateDir, '--dev-key', '--host', args.host];
  if (args.tls) command.push('--tls');
  if (args.nshPath !== null) command.push('--nsh', args.nshPath);
  const raw = await runBridgeJson(settings.bridgeCliPath, command, INIT_TIMEOUT_MS);
  const report = await inspectSetup(settings);
  return {
    ok: true,
    alreadyInitialized: false,
    host: args.host,
    tls: args.tls,
    init: summarizeInit(raw),
    report,
  };
}

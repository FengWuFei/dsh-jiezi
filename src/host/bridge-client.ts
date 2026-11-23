/**
 * Minimal HTTP-over-Unix-socket client for `jiezi-bridge`.
 *
 * The Host plugin never builds, signs, or talks to the phone itself; every
 * delivery operation is a narrow bridge call. This module is the only place a
 * socket path and a bridge failure become a shared error code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JieZiError, knownCode } from '../shared/errors.js';

/** Resolved plugin settings shared by the Host routes and the preset tools. */
export interface BridgeSettings {
  socketPath: string;
  stateDir: string;
  bridgeCliPath: string;
  autoStart: boolean;
  timeoutMs: number;
  /** Where miniapp_init puts a new project relative to the Session working directory. */
  projectLayout: ProjectLayout;
}

/**
 * `working-directory` initializes the Session working directory itself (it must
 * be empty); `named-subdirectory` creates `<cwd>/<projectId>` so one working
 * directory can hold several mini-apps.
 */
export type ProjectLayout = 'working-directory' | 'named-subdirectory';

/** Default socket path under the user's home. */
export function defaultSocketPath(): string {
  return process.env.JIEZI_BRIDGE_SOCKET ?? join(homedir(), '.jiezi', 'bridge.sock');
}

/** Packaged bridge CLI, copied into `lib/bridge` by scripts/build.mjs. */
const PACKAGED_BRIDGE_CLI = fileURLToPath(new URL('../bridge/cli.js', import.meta.url));
/** Source-checkout bridge CLI, valid only when running from this repository. */
const REPO_BRIDGE_CLI = fileURLToPath(new URL('../../../vendor/bridge/src/cli.js', import.meta.url));
/** Packaged bridge manifest, used for the exact version lock. */
const PACKAGED_BRIDGE_PACKAGE = fileURLToPath(new URL('../bridge/package.json', import.meta.url));
const REPO_BRIDGE_PACKAGE = fileURLToPath(new URL('../../../vendor/bridge/package.json', import.meta.url));

/**
 * Resolve the bridge CLI: an explicit environment override, then the copy
 * bundled in this package, then the repository sibling for source checkouts.
 * Returning the packaged path when nothing exists keeps setup errors specific.
 */
export function defaultBridgeCliPath(): string {
  const override = process.env.JIEZI_BRIDGE_CLI;
  if (typeof override === 'string' && override.length > 0) return override;
  if (existsSync(PACKAGED_BRIDGE_CLI)) return PACKAGED_BRIDGE_CLI;
  if (existsSync(REPO_BRIDGE_CLI)) return REPO_BRIDGE_CLI;
  return PACKAGED_BRIDGE_CLI;
}

/**
 * Version of the bridge that ships in this package, or null when this is a
 * source checkout without a build. The supervisor uses it as the exact
 * contract for a bridge it may reuse or restart.
 */
export function bundledBridgeVersion(): string | null {
  for (const path of [PACKAGED_BRIDGE_PACKAGE, REPO_BRIDGE_PACKAGE]) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && value.version.length > 0) return value.version;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

/** Resolve one plugin row's config into settings. */
export function resolveBridgeSettings(config: unknown = {}): BridgeSettings {
  const value = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const socket = typeof value.socketPath === 'string' && value.socketPath.length > 0
    ? value.socketPath
    : defaultSocketPath();
  const cliPath = typeof value.bridgeCliPath === 'string' && value.bridgeCliPath.length > 0
    ? value.bridgeCliPath
    : defaultBridgeCliPath();
  const timeout = Number(value.timeoutMs);
  return {
    socketPath: socket,
    stateDir: typeof value.stateDir === 'string' && value.stateDir.length > 0 ? value.stateDir : dirname(socket),
    bridgeCliPath: cliPath,
    autoStart: value.autoStart === true,
    projectLayout: value.projectLayout === 'named-subdirectory' ? 'named-subdirectory' : 'working-directory',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(Math.trunc(timeout), 1_000), 120_000) : 30_000,
  };
}

/** Largest bridge response accepted; evidence bodies stay on disk. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface BridgeErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/**
 * One bridge client bound to one socket and timeout. Instances are cheap; the
 * operations layer reuses one per settings pair.
 */
export class BridgeClient {
  constructor(
    readonly settings: BridgeSettings,
    private readonly ensureAvailable?: () => Promise<void>,
  ) {}

  /** GET one bridge path. */
  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** POST one bridge path with a JSON body. */
  post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** One request, starting the configured bridge once after a refused socket. */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    try {
      return await this.requestOnce<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof JieZiError) || error.code !== 'bridge_unavailable' || this.ensureAvailable === undefined) {
        throw error;
      }
      await this.ensureAvailable();
      return this.requestOnce<T>(method, path, body);
    }
  }

  /** One request attempt, mapping transport and protocol failures onto shared codes. */
  private requestOnce<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const request = httpRequest({
        socketPath: this.settings.socketPath,
        path,
        method,
        headers: {
          accept: 'application/json',
          ...(payload === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('bridge response exceeds 1 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let value: unknown;
          try {
            value = text.length === 0 ? {} : JSON.parse(text);
          } catch {
            reject(new JieZiError('bridge_protocol', `bridge returned non-JSON (HTTP ${response.statusCode ?? 0})`));
            return;
          }
          const record = value !== null && typeof value === 'object' && !Array.isArray(value)
            ? value as BridgeErrorBody & Record<string, unknown>
            : {};
          const status = response.statusCode ?? 0;
          if (status >= 400 || record.error !== undefined) {
            const code = record.error === undefined ? 'bridge_protocol' : knownCode(record.error.code);
            const message = record.error !== undefined && typeof record.error.message === 'string'
              ? record.error.message
              : `bridge request failed (HTTP ${status})`;
            reject(new JieZiError(code, message.slice(0, 500)));
            return;
          }
          resolve(value as T);
        });
        response.on('error', (error) => {
          reject(new JieZiError('bridge_protocol', error.message));
        });
      });
      request.setTimeout(this.settings.timeoutMs, () => {
        request.destroy(new JieZiError('bridge_timeout', `bridge did not answer within ${this.settings.timeoutMs}ms`));
      });
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error instanceof JieZiError) {
          reject(error);
          return;
        }
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          reject(new JieZiError(
            'bridge_unavailable',
            `jiezi-bridge is not running at ${this.settings.socketPath}. Start it with: jiezi-bridge serve --state-dir <state>`,
          ));
          return;
        }
        reject(new JieZiError('bridge_protocol', error.message));
      });
      if (payload !== null) request.write(payload);
      request.end();
    });
  }

  /**
   * Open the bridge's server-sent event stream once. Reconnection belongs to
   * the caller's lifecycle; `onClose` fires on every stream end so it can
   * schedule one.
   * @param handlers - parsed event callback plus a single close notification.
   * @returns a stop function that destroys the request without calling back.
   */
  openEventStream(handlers: {
    onEvent(type: string, payload: Record<string, unknown>): void;
    onClose(): void;
  }): () => void {
    let closed = false;
    const request = httpRequest({
      socketPath: this.settings.socketPath,
      path: '/v1/events',
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        if (!closed) handlers.onClose();
        return;
      }
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const split = buffer.indexOf('\n\n');
          if (split < 0) break;
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = parseEventBlock(block);
          if (event !== null) handlers.onEvent(event.type, event.payload);
        }
      });
      response.on('end', () => {
        if (!closed) handlers.onClose();
      });
      response.on('error', () => {
        if (!closed) handlers.onClose();
      });
    });
    request.on('error', () => {
      if (!closed) handlers.onClose();
    });
    request.end();
    return () => {
      closed = true;
      request.destroy();
    };
  }
}

/** Decode one SSE block; malformed data is ignored, not fatal. */
function parseEventBlock(block: string): { type: string; payload: Record<string, unknown> } | null {
  let type = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    const value: unknown = JSON.parse(data.join('\n'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return { type, payload: value as Record<string, unknown> };
  } catch {
    return null;
  }
}

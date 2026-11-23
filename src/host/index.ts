/**
 * Global Host row `jiezi-runtime`.
 *
 * It registers the authenticated, same-origin `/api/jiezi/*` routes the
 * browser panel reads. It registers no model-facing tools and no Client slot:
 * tools stay in the preset row (`dsh-jiezi/tools`), and the panel is
 * the package's separate Client half. Every route delegates to the shared
 * operations layer, so the UI and the Agent never fork business logic.
 *
 * One exact route exists per path: Connection keys its exact Fetch registry by
 * path and throws when a second registration repeats it, so `pairing` and
 * `automation` dispatch on `request.method` inside one handler.
 */

import { API_ROUTES, MAX_API_BODY_BYTES } from '../shared/protocol.js';
import { JieZiError, httpStatusFor, toPublicError } from '../shared/errors.js';
import { getSharedOperations, type JieZiOperations } from './operations.js';

/** Route shape accepted by `ctx.connection.fetch.register`. */
export interface HostFetchRoute {
  readonly path: string;
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

/** The subset of the Host context this plugin uses. */
export interface HostContext {
  connection: {
    fetch: {
      register(route: HostFetchRoute): () => Promise<void> | void;
    };
  };
  effect(factory: () => void | (() => unknown), label?: string): void;
}

/** Plugin row name reported by the loader. */
export const name = 'jiezi-runtime';

/** Routes require the authenticated Connection service. */
export const inject = ['connection'];

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function query(request: Request, name: string): string | undefined {
  const value = new URL(request.url, 'http://127.0.0.1').searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

/** Read one bounded JSON body; a malformed or oversize body is a 4xx, not a crash. */
async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) {
    throw new JieZiError('body_too_large', `request body exceeds ${MAX_API_BODY_BYTES} bytes`);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_API_BODY_BYTES) {
    throw new JieZiError('body_too_large', `request body exceeds ${MAX_API_BODY_BYTES} bytes`);
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new JieZiError('invalid_request', 'request body must be JSON');
  }
}

/** Turn one operation into a JSON Response, preserving actionable failures. */
async function settle(operation: () => Promise<unknown> | unknown): Promise<Response> {
  try {
    return json(200, await operation());
  } catch (error) {
    const body = toPublicError(error);
    return json(httpStatusFor(body.error.code), body);
  }
}

/** Build the route table once so registration and tests share one source. */
export function buildRoutes(operations: JieZiOperations): HostFetchRoute[] {
  return [
    {
      path: API_ROUTES.status,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => settle(() => operations.status()),
    },
    {
      // GET reads the doctor; POST initializes only with explicit consent.
      path: API_ROUTES.setup,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => {
        if (request.method === 'POST') {
          return settle(async () => operations.setupInitialize(await readJson(request)));
        }
        return settle(() => operations.setupReport());
      },
    },
    {
      // POST creates one session; GET reads the remembered or named session.
      path: API_ROUTES.pairing,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => {
        if (request.method === 'POST') {
          return settle(async () => operations.createPairing(await readJson(request)));
        }
        const sessionId = query(request, 'sessionId');
        return settle(() => operations.pairingStatus(sessionId === undefined ? {} : { sessionId }));
      },
    },
    {
      // GET reads the shared device schema; POST launches/recover one device.
      path: API_ROUTES.devices,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => request.method === 'POST'
        ? settle(async () => operations.device(await readJson(request)))
        : settle(() => operations.device({ action: 'list' })),
    },
    {
      // POST restarts the supervised bridge or runs the readiness doctor.
      path: API_ROUTES.bridge,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => settle(async () => {
        const body = await readJson(request);
        const action = body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>).action
          : undefined;
        if (action === 'restart') return operations.restartBridge();
        if (action === 'doctor') {
          const fix = (body as Record<string, unknown>).fix === true;
          return operations.doctor({ fix });
        }
        throw new JieZiError('invalid_request', 'action must be restart or doctor');
      }),
    },
    {
      path: API_ROUTES.deploy,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => settle(async () => operations.deploy(await readJson(request))),
    },
    {
      path: API_ROUTES.operation,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => settle(() => {
        const opId = query(request, 'opId');
        const deviceId = query(request, 'deviceId');
        return operations.operation({
          ...(opId === undefined ? {} : { opId }),
          ...(deviceId === undefined ? {} : { deviceId }),
        });
      }),
    },
    {
      path: API_ROUTES.diagnostics,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => settle(() => {
        const opId = query(request, 'opId');
        const evidenceId = query(request, 'evidenceId');
        return operations.diagnostics({
          ...(opId === undefined ? {} : { opId }),
          ...(evidenceId === undefined ? {} : { evidenceId }),
        });
      }),
    },
    {
      // POST starts one observe/tap request; GET reads an existing request.
      path: API_ROUTES.automation,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => {
        if (request.method === 'POST') {
          return settle(async () => operations.startAutomation(await readJson(request)));
        }
        return settle(async () => {
          const requestId = query(request, 'requestId');
          if (requestId === undefined) throw new JieZiError('invalid_request', 'requestId is required');
          return operations.automationStatus({ requestId });
        });
      },
    },
    {
      path: API_ROUTES.unpair,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => settle(async () => operations.unpair(await readJson(request))),
    },
  ];
}

/**
 * Register the runtime routes with the owning Host context.
 * @param ctx - Host context providing the authenticated Fetch registry.
 * @param config - optional `{ socketPath, timeoutMs }` row config.
 */
export function apply(ctx: HostContext, config: unknown = {}): void {
  const operations = getSharedOperations(config);
  const routes = buildRoutes(operations);
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.connection.fetch.register(route));
    return () => {
      for (const dispose of disposers) {
        const result = dispose();
        if (result instanceof Promise) void result;
      }
    };
  }, 'jiezi-runtime: authenticated API routes');

  const settings = operations.settings;
  if (settings.autoStart) {
    ctx.effect(() => {
      // Status remains the observable error surface; a stopped/uninitialized
      // bridge is expected before first-time setup and must not reject activation.
      void operations.ensureBridge().catch(() => {});
    }, 'jiezi-runtime: bridge supervisor');
  }
}

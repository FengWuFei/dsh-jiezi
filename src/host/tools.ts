/**
 * Preset plugin `dsh-jiezi/tools`.
 *
 * Registers one always-on `miniapp` action-enum tool plus two observation tools
 * that are admitted only after the bundled `jiezi-miniapp` skill loads. The
 * tools and the browser panel call the same operations layer (`operations.ts`),
 * so a deploy or automation result has one shape and one set of bounds.
 *
 * Capability parity with the previous fourteen tools is deliberate: every old
 * tool maps onto one `miniapp` action, one `miniapp_ui` mode, or
 * `miniapp_action`. `test/tools.test.js` asserts that mapping.
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  MAX_TOOL_RESULT_CHARS,
  parseAutomationArgs,
  toolFailure,
  truncateResult,
  type AutomationAction,
} from '../shared/protocol.js';
import { getSharedOperations, type AutomationResult } from './operations.js';
import { resolveBridgeSettings } from './bridge-client.js';
import { JieZiError } from '../shared/errors.js';

/** Tool registration shape consumed by `ctx.tools.register`. */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec?: ToolExecution): Promise<unknown>;
}

/** Per-registration admission predicate; the harness evaluates it per request. */
interface ToolRegistration {
  when?(context: { agent?: unknown }): boolean;
}

/** Agent handle available to a tool call; delivery reads its live status. */
interface ToolExecution {
  agent?: {
    readonly status?: 'idle' | 'running';
    readonly session?: SessionLike;
    followup(message: unknown): void;
    inject?(message: unknown): void;
  };
  signal?: AbortSignal;
}

/** The exact slice of a live Session this plugin reads. */
interface SessionLike {
  header?: { cwd?: string };
  requestHeader?(): { tools?: Array<{ name?: string }> } | null;
}

/** The subset of the preset context this plugin uses. */
interface ToolsContext {
  tools: { register(definition: ToolDefinition, options?: ToolRegistration): () => void };
  systemPrompt: {
    section(section: {
      name: string;
      order: number;
      text: string;
      interpolate?: boolean;
      retirement?: string;
    }): () => void;
  };
  effect(factory: () => void | (() => unknown), label?: string): void;
  on?(event: string, handler: (first: unknown, second: unknown) => void): (() => void) | void;
  get?(name: string): unknown;
}

/** Plugin row name reported by the loader. */
export const name = 'jiezi-tools';

/** Tools, prompt text and activation marks are the only contributions. */
export const inject = ['tools', 'systemPrompt', 'agents'];

/** Observation tools admitted after one of these skills loads. */
const DEFAULT_ACTIVATION_SKILLS = ['jiezi-miniapp'];
const GATED_TOOL_NAMES = new Set(['miniapp_ui', 'miniapp_action']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const STATE_LABEL: Record<string, string> = {
  pending: 'waiting for the device',
  downloading: 'downloading the package',
  verifying: 'verifying the package',
  installing: 'installing',
  launching: 'launching',
  running: 'running',
  failed: 'failed',
};

const FAILURE_LAYERS = new Set(['compile', 'load', 'runtime', 'host-component', 'refused', 'timeout']);

/** Default blocking wait for one terminal deployment status. */
const DEFAULT_STATUS_WAIT_MS = 30_000;
/** Upper bound for one blocking status wait; a deployment can outlast a turn. */
const MAX_STATUS_WAIT_MS = 10 * 60_000;
/** Bound for the one-line notice summary, matching the harness context bound. */
const DELIVERY_SUMMARY_MAX_CHARS = 120;
/** The `miniapp` action enum, mirrored by the schema and the dispatcher. */
const MINIAPP_ACTIONS = [
  'init',
  'build',
  'deploy',
  'status',
  'reload',
  'open',
  'device',
  'doctor',
  'diagnostics',
] as const;
type MiniappAction = (typeof MINIAPP_ACTIONS)[number];
/** The `miniapp_ui` modes: semantic outline, page evidence, full device screen. */
const UI_MODES = ['outline', 'capture', 'screen'] as const;
type UiMode = (typeof UI_MODES)[number];
/** Keys each gateway action reads; anything else is an error, never a silent no-op. */
const MINIAPP_KEYS: Record<MiniappAction, readonly string[]> = {
  init: ['action', 'projectId', 'name', 'appId'],
  build: ['action', 'projectId', 'projectDir'],
  deploy: ['action', 'deviceId', 'releaseId', 'force'],
  status: ['action', 'opId', 'deviceId', 'wait', 'timeoutMs'],
  reload: ['action', 'deviceId', 'releaseId', 'appId'],
  open: ['action', 'deviceId', 'appId', 'timeoutMs'],
  device: ['action', 'deviceAction', 'deviceId', 'hostDeviceId', 'rebind', 'waitMs'],
  doctor: ['action', 'fix'],
  diagnostics: ['action', 'opId', 'evidenceId'],
};
/** Keys each `miniapp_ui` mode reads. */
const UI_KEYS: Record<UiMode, readonly string[]> = {
  outline: ['deviceId', 'mode', 'appId', 'instanceId', 'snapshotId', 'diagnosticCursor', 'includeFrames', 'includeHidden', 'opId', 'timeoutMs'],
  capture: ['deviceId', 'mode', 'waitMs', 'requestId'],
  screen: ['deviceId', 'mode', 'hostDeviceId'],
};

/** Narrow one bridge state to the values that end a wait. */
function isTerminalState(value: unknown): value is 'running' | 'failed' {
  return value === 'running' || value === 'failed';
}

/** Bound the notice summary the transcript shows without expanding the row. */
function boundDeliverySummary(opId: string, state: string): string {
  const summary = `deploy ${opId} ${state}`;
  return summary.length <= DELIVERY_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, DELIVERY_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Validate the optional blocking wait duration. */
function statusWaitTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_STATUS_WAIT_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000 || value > MAX_STATUS_WAIT_MS) {
    throw new JieZiError('invalid_request', `timeoutMs must be an integer from 1000 to ${MAX_STATUS_WAIT_MS}`);
  }
  return value;
}

/** One pending terminal-status wake for a blocking status call. */
type StatusWaiter = () => void;

/** Delivery bookkeeping owned by one plugin instance and its event stream. */
interface DeliveryState {
  /** Agents that deployed an operation and have not received its terminal update. */
  pendingAgents: Map<string, NonNullable<ToolExecution['agent']>>;
  /** Blocking status calls waiting for one operation's terminal event. */
  waiters: Map<string, Set<StatusWaiter>>;
}

/** One text result renderer; bounded before it reaches the model. */
function renderText(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated`;
}

/** Shared tool envelope: object arguments, one JSON result, bounded render. */
function tool(definition: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, exec?: ToolExecution): Promise<unknown>;
}): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: renderText(value) }];
      },
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return toolFailure(new JieZiError('invalid_request', 'arguments must be an object'));
      }
      try {
        return truncateResult(await definition.execute(args as Record<string, unknown>, exec));
      } catch (error) {
        // A cancelled tool call must stay cancelled; a structured failure would
        // report the wait as an ordinary result.
        if (exec?.signal?.aborted === true) throw error;
        return toolFailure(error);
      }
    },
  };
}

/** Reject keys the selected action/mode does not read. */
function rejectKeys(args: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new JieZiError('invalid_request', `${key} is not valid for ${context}`);
    }
  }
}

/** Copy only the declared fields that were actually provided. */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

/** Generate the idempotency key of one automation call. */
function automationOpId(args: Record<string, unknown>): string {
  if (typeof args.opId === 'string' && args.opId.length > 0) return args.opId;
  return `op_auto_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Map one bounded automation result into the model-facing shape. */
function automationToolResult(result: AutomationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    action: result.action,
    requestId: result.requestId,
    state: result.state,
    deviceId: result.deviceId,
    opId: result.opId,
    appId: result.appId,
    instanceId: result.instanceId,
    snapshotId: result.snapshotId,
    nodeCount: result.nodeCount,
    outline: result.outline,
    error: result.error,
    verification: result.verification,
    diagnostics: result.diagnostics,
    diagnosticCursor: result.diagnosticCursor,
    hostAlert: result.hostAlert,
    host: result.host,
    runtimeError: result.runtimeError,
    deduplicated: result.deduplicated,
    snapshotIssues: result.snapshotIssues,
  };
}

/** The Session working directory, where a new mini-app is created. */
function sessionRoot(exec?: ToolExecution): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined;
}

/** Validate the configured activation skills, defaulting to the bundled skill. */
function activationSkillsOf(config: unknown): Set<string> {
  const value = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).activationSkills
    : undefined;
  if (value === undefined) return new Set(DEFAULT_ACTIVATION_SKILLS);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('dsh-jiezi: activationSkills must be a non-empty array of skill names');
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !SKILL_NAME.test(entry)) {
      throw new Error(`dsh-jiezi: activationSkills contains an invalid skill name: ${JSON.stringify(entry)}`);
    }
    names.push(entry);
  }
  return new Set(names);
}

/** The parameter schema shared by the single `miniapp` gateway tool. */
function miniappParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...MINIAPP_ACTIONS],
        description: 'Operation to run. Required fields: init/build projectId; deploy deviceId+releaseId; status opId (or deviceId for the recent list), wait needs opId; reload deviceId; open deviceId+appId; device deviceAction (ensure_ready needs deviceId; list takes no deviceId); doctor none; diagnostics opId or evidenceId.',
      },
      projectId: { type: 'string', description: 'Project slug for init/build.' },
      projectDir: { type: 'string', description: 'Absolute project directory when build must not use the default.' },
      name: { type: 'string', description: 'Display name for init; defaults to a title-cased project id.' },
      appId: { type: 'string', description: 'Reverse-DNS app id for init/open/reload.' },
      deviceId: { type: 'string', description: 'Paired device id. Required for deploy/reload/open/ensure_ready; optional for status; rejected by device list.' },
      deviceAction: {
        type: 'string',
        enum: ['list', 'ensure_ready', 'launch_host'],
        description: 'For action=device: list devices (default; rejects deviceId/hostDeviceId), ensure_ready (requires deviceId), or launch_host (deviceId optional; hostDeviceId/waitMs apply).',
      },
      releaseId: { type: 'string', description: 'Release id for deploy/reload.' },
      opId: { type: 'string', description: 'Operation id for status/diagnostics.' },
      evidenceId: { type: 'string', description: 'Evidence id for diagnostics.' },
      force: { type: 'boolean', description: 'For deploy: start a fresh install instead of reusing a deduplicated operation.' },
      wait: { type: 'boolean', description: 'For status: block until running or failed; requires opId; defaults to false.' },
      timeoutMs: { type: 'integer', description: 'For status wait: 1000-600000 ms, default 30000. For open: 1000-30000 ms, default 15000. Ignored otherwise.' },
      fix: { type: 'boolean', description: 'For doctor: apply safe repairs (stale nsh path, stale bridge restart).' },
      hostDeviceId: { type: 'string', description: 'For device: CoreDevice/simulator UDID for a first binding or explicit rebind.' },
      rebind: { type: 'boolean', description: 'For device: must be true to replace an existing binding.' },
      waitMs: { type: 'integer', description: 'For device ensure_ready or launch_host: readiness timeout 1000-90000 ms, default 30000.' },
    },
    required: ['action'],
    additionalProperties: false,
  };
}

/** The parameter schema of the gated `miniapp_ui` tool. */
function uiParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      deviceId: { type: 'string', description: 'Paired device id.' },
      mode: {
        type: 'string',
        enum: [...UI_MODES],
        description: 'outline reads a semantic outline for miniapp_action (default); capture returns the page tree plus screenshot path; screen captures the complete device PNG through the Host and returns its local path only.',
      },
      appId: { type: 'string', description: 'Expected active mini-app id; mismatches fail instead of observing another app.' },
      instanceId: { type: 'string', description: 'Expected mini-app instance id.' },
      snapshotId: { type: 'string', description: 'Snapshot id to read again.' },
      diagnosticCursor: { type: 'integer', description: 'Diagnostic cursor from a previous outline.' },
      includeFrames: { type: 'boolean', description: 'Include each visible node frame and the screen size; defaults to false.' },
      includeHidden: { type: 'boolean', description: 'Include hidden accessibility nodes; defaults to false.' },
      opId: { type: 'string', description: 'Idempotency id for an outline read; omit to generate one.' },
      requestId: { type: 'string', description: 'For capture: a pending capture request id to read again.' },
      waitMs: { type: 'integer', description: 'For capture: how long the device may take, 0 to 15000; defaults to 5000.' },
      hostDeviceId: { type: 'string', description: 'For screen: CoreDevice/simulator UDID used when no binding exists; an existing different binding needs miniapp action=device rebind.' },
      timeoutMs: { type: 'integer', description: 'For outline: how long the device may take, 1000-30000 ms; default 15000.' },
    },
    required: ['deviceId'],
    additionalProperties: false,
  };
}

/** The parameter schema of the gated `miniapp_action` tool. */
function actionParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      deviceId: { type: 'string', description: 'Paired device id.' },
      opId: { type: 'string', description: 'Idempotency id; omit to generate one for this call.' },
      action: { type: 'string', enum: ['tap', 'type', 'scroll'], description: 'tap a control (default), type into a text field, or scroll the nearest scroll view of the target.' },
      appId: { type: 'string', description: 'Expected active mini-app id.' },
      instanceId: { type: 'string', description: 'Expected mini-app instance id; a changed instance fails as stale.' },
      snapshotId: { type: 'string', description: 'Snapshot the target selectors were read from.' },
      diagnosticCursor: { type: 'integer', description: 'Diagnostic cursor from the snapshot used to choose the target.' },
      includeFrames: { type: 'boolean', description: 'Include each visible node frame and the screen size in the returned outline; defaults to false.' },
      includeHidden: { type: 'boolean', description: 'Include hidden accessibility nodes in the returned outline; defaults to false.' },
      target: {
        type: 'object',
        description: 'One unique selector: testID, or alias/path from miniapp_ui, or label plus role. For type, the target or its subtree must contain the text input.',
        properties: {
          testID: { type: 'string' },
          label: { type: 'string' },
          role: { type: 'string' },
          alias: { type: 'string' },
          path: { type: 'string' },
        },
        additionalProperties: false,
      },
      text: { type: 'string', description: 'Required for action=type: text to write, up to 1024 characters.' },
      replace: { type: 'boolean', description: 'For action=type, replace the field text (default true) or append at the caret (false).' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'For action=scroll, the content direction; defaults to down.' },
      amount: { type: 'number', description: 'For action=scroll, the fraction of the viewport to move, 0.1 to 1; defaults to 0.8.' },
      expect: {
        type: 'object',
        description: 'Post-action assertion evaluated after the device returns a fresh snapshot. Conditions are ANDed; use checks to assert several scoped testIDs or texts in one call.',
        properties: {
          visibleTestID: { type: 'string' },
          visibleLabel: { type: 'string' },
          textContains: { type: 'string' },
          textEquals: { type: 'string' },
          checks: {
            type: 'array',
            description: 'Up to 8 scoped checks. Text is scoped to the check testID (or label), so progress and hint text can be asserted together.',
            items: {
              type: 'object',
              properties: {
                testID: { type: 'string' },
                label: { type: 'string' },
                textContains: { type: 'string' },
                textEquals: { type: 'string' },
                focused: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      timeoutMs: { type: 'integer', description: 'How long the device may take, 1000 to 30000; defaults to 15000.' },
    },
    required: ['deviceId', 'target'],
    additionalProperties: false,
  };
}

/**
 * Register the `miniapp` gateway, the skill-gated observation tools and the
 * prompt section on the preset context. Any operation failure becomes a
 * structured tool result; only a throw from registration itself propagates.
 */
export function apply(ctx: ToolsContext, config: unknown = {}): void {
  const settings = resolveBridgeSettings(config);
  const operations = getSharedOperations(settings);
  const delivery: DeliveryState = { pendingAgents: new Map(), waiters: new Map() };
  const activationSkills = activationSkillsOf(config);
  const marked = new WeakSet<object>();

  /** Admit a tool once its Agent loaded an activation skill. */
  function remember(skillName: unknown, agent: unknown): void {
    if (typeof skillName !== 'string' || !activationSkills.has(skillName)) return;
    if (agent === null || typeof agent !== 'object') return;
    marked.add(agent);
  }

  /** Per-request admission: in-memory mark, or a prior declaration on resume/fork. */
  function when(context: { agent?: unknown }): boolean {
    const agent = context?.agent;
    if (agent === null || typeof agent !== 'object') return false;
    if (marked.has(agent)) return true;
    let declared: Array<{ name?: string }> | null | undefined;
    try {
      declared = (agent as { session?: SessionLike }).session?.requestHeader?.()?.tools;
    } catch {
      return false;
    }
    if (!Array.isArray(declared)) return false;
    return declared.some((entry) => {
      const name = entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;
      return typeof name === 'string' && GATED_TOOL_NAMES.has(name);
    });
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const disposers = [
        ctx.on?.('tools/result', (first, second) => {
          const exec = first as { agent?: unknown; name?: unknown; arguments?: unknown } | undefined;
          const result = second as { isError?: unknown } | undefined;
          if (exec?.name !== 'skill' || result?.isError === true) return;
          const args = exec.arguments;
          const skillName = args !== null && typeof args === 'object'
            ? (args as { name?: unknown }).name
            : undefined;
          remember(skillName, exec.agent);
        }),
        ctx.on?.('session/event', (first, second) => {
          const session = first as { id?: unknown } | undefined;
          const event = second as { type?: unknown; data?: { source?: { kind?: unknown; name?: unknown } } } | undefined;
          if (event?.type !== 'user/message') return;
          const source = event.data?.source;
          if (source?.kind !== 'skill-invocation' || typeof source.name !== 'string' || !activationSkills.has(source.name)) return;
          const agents = ctx.get?.('agents') as { get?(id: unknown): { session?: unknown } | undefined } | undefined;
          const agent = agents?.get?.(session?.id);
          if (agent !== undefined && agent.session === session) remember(source.name, agent);
        }),
        ctx.on?.('agent/disposed', (first) => {
          const agent = (first as { agent?: unknown } | undefined)?.agent;
          if (agent !== null && typeof agent === 'object') marked.delete(agent);
        }),
      ].filter((dispose): dispose is () => void => typeof dispose === 'function');
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'jiezi-tools: skill activation');
  }

  /**
   * Block one status read on the bridge event stream or the timeout.
   * A terminal event resolves the wait and suppresses the unsolicited notice,
   * so the result reaches the model exactly once.
   */
  async function waitForOperation(
    opId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    let resolveTerminal: StatusWaiter = () => {};
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
      let waiting = delivery.waiters.get(opId);
      if (waiting === undefined) {
        waiting = new Set();
        delivery.waiters.set(opId, waiting);
      }
      waiting.add(resolve);
    });
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    try {
      // Read after subscribing so a terminal event cannot land unseen between
      // the initial read and the wait.
      const current = await operations.operation({ opId });
      if (isTerminalState(current.op?.state)) return { ...current, timedOut: false };
      const outcome = await Promise.race([terminal.then(() => 'terminal' as const), timedOut, cancelled]);
      const latest = await operations.operation({ opId });
      return { ...latest, timedOut: outcome === 'timeout' };
    } finally {
      if (timer !== null) clearTimeout(timer);
      const waiting = delivery.waiters.get(opId);
      waiting?.delete(resolveTerminal);
      if (waiting !== undefined && waiting.size === 0) delivery.waiters.delete(opId);
    }
  }

  /** Attach host compatibility to a status/operation result. */
  async function withHost(result: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = result.op !== null && typeof result.op === 'object' && !Array.isArray(result.op)
      ? result.op as Record<string, unknown>
      : null;
    const opDeviceId = op !== null && typeof op.deviceId === 'string' ? op.deviceId : null;
    if (opDeviceId === null) return result;
    return { ...result, host: await operations.hostInfo(opDeviceId) };
  }

  /** Run one `miniapp` action; the switch is the capability-parity boundary. */
  async function runMiniapp(
    action: MiniappAction,
    args: Record<string, unknown>,
    exec?: ToolExecution,
  ): Promise<unknown> {
    rejectKeys(args, MINIAPP_KEYS[action], `action=${action}`);
    switch (action) {
      case 'init':
        return operations.init(pick(args, ['projectId', 'name', 'appId']), sessionRoot(exec));
      case 'build':
        return operations.build(pick(args, ['projectId', 'projectDir']), sessionRoot(exec));
      case 'deploy': {
        const result = await operations.deploy(pick(args, ['deviceId', 'releaseId', 'force']));
        const opId = typeof result.opId === 'string' ? result.opId : null;
        if (result.ok !== false && opId !== null && exec?.agent !== undefined) {
          delivery.pendingAgents.set(opId, exec.agent);
        }
        return result;
      }
      case 'status': {
        const opId = typeof args.opId === 'string' ? args.opId : undefined;
        const deviceId = typeof args.deviceId === 'string' ? args.deviceId : undefined;
        if (args.wait === true) {
          if (opId === undefined) throw new JieZiError('invalid_request', 'wait requires opId');
          return withHost(await waitForOperation(opId, statusWaitTimeout(args.timeoutMs), exec?.signal));
        }
        return withHost(await operations.operation({
          ...(opId === undefined ? {} : { opId }),
          ...(deviceId === undefined ? {} : { deviceId }),
        }));
      }
      case 'reload':
        return operations.reload(pick(args, ['deviceId', 'releaseId', 'appId']));
      case 'open':
        return operations.open(pick(args, ['deviceId', 'appId', 'timeoutMs']));
      case 'device': {
        const requested = args.deviceAction;
        if (requested !== undefined
          && requested !== 'list'
          && requested !== 'ensure_ready'
          && requested !== 'launch_host') {
          throw new JieZiError('invalid_request', 'deviceAction must be list, ensure_ready or launch_host');
        }
        const deviceAction = requested ?? 'list';
        return operations.device({
          action: deviceAction,
          ...pick(args, ['deviceId', 'hostDeviceId', 'rebind', 'waitMs']),
        });
      }
      case 'doctor':
        return operations.doctor(pick(args, ['fix']));
      case 'diagnostics':
        return operations.diagnostics(pick(args, ['opId', 'evidenceId']));
      default: {
        const unknown = action as string;
        throw new JieZiError('invalid_request', `unknown miniapp action ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** Run one `miniapp_ui` mode; capture and screen keep their old bounds. */
  async function runUi(args: Record<string, unknown>): Promise<unknown> {
    const requestedMode = args.mode;
    if (requestedMode !== undefined && !(UI_MODES as readonly string[]).includes(requestedMode as string)) {
      throw new JieZiError('invalid_request', `mode must be one of ${UI_MODES.join(', ')}`);
    }
    const mode = requestedMode === 'capture' || requestedMode === 'screen' ? requestedMode : 'outline';
    rejectKeys(args, UI_KEYS[mode], `mode=${mode}`);
    if (mode === 'capture') {
      const result = await operations.capture(pick(args, ['deviceId', 'waitMs', 'requestId']));
      const treeText = result.tree === null || result.tree === undefined ? '' : JSON.stringify(result.tree);
      if (treeText.length <= 12_000) return result;
      return {
        ok: true,
        requestId: result.requestId,
        state: result.state,
        deviceId: result.deviceId,
        tree: null,
        treeTruncated: true,
        treeChars: treeText.length,
        screenshotPath: result.screenshotPath,
        note: result.note ?? 'The page tree exceeded the inline bound; use mode=outline for semantic nodes or the screenshot path for pixels.',
      };
    }
    if (mode === 'screen') {
      return operations.screen(pick(args, ['deviceId', 'hostDeviceId']));
    }
    return automationToolResult(await operations.startAutomation({
      ...pick(args, [
        'deviceId',
        'appId',
        'instanceId',
        'snapshotId',
        'diagnosticCursor',
        'includeFrames',
        'includeHidden',
        'timeoutMs',
      ]),
      action: 'observe',
      opId: automationOpId(args),
    }));
  }

  /** Run one gated `miniapp_action`; same arguments and result shape as before. */
  async function runAction(args: Record<string, unknown>): Promise<unknown> {
    const action: AutomationAction = args.action === 'type'
      ? 'type'
      : args.action === 'scroll'
        ? 'scroll'
        : 'tap';
    const request = parseAutomationArgs(action, { ...args, opId: automationOpId(args) });
    return automationToolResult(await operations.automation(request));
  }

  const miniappTool = tool({
    name: 'miniapp',
    description: 'JieZi mini-app project, delivery and environment operations in one action-enum tool. A successful deploy wakes this Agent when the operation ends. The jiezi-miniapp skill owns the procedure, per-action requirements and failure routing.',
    parameters: miniappParameters(),
    async execute(args, exec) {
      const action = args.action;
      if (typeof action !== 'string' || !(MINIAPP_ACTIONS as readonly string[]).includes(action)) {
        throw new JieZiError('invalid_request', `action must be one of ${MINIAPP_ACTIONS.join(', ')}`);
      }
      return runMiniapp(action as MiniappAction, args, exec);
    },
  });

  const uiTool = tool({
    name: 'miniapp_ui',
    description: 'Read the current mini-app or device screen. mode=outline returns a bounded semantic outline with aliases, testIDs, labels, roles, paths and a diagnostic cursor that miniapp_action can target; mode=capture returns the page tree and screenshot path; mode=screen captures the complete device PNG through the Host and returns its local path (the image itself is not returned). Requires a connected device; outline and capture need developer automation.',
    parameters: uiParameters(),
    async execute(args) {
      return runUi(args);
    },
  });

  const actionTool = tool({
    name: 'miniapp_action',
    description: 'Tap one unique visible control, type into one text field, or scroll the nearest scroll view, in the current mini-app by testID, label, role, alias, or path. Returns the new bounded outline (including modal-dialog nodes and focused non-secure text values), verification result, and diagnostic events from this action. A missing, ambiguous, disabled, stale, non-input, or alert-blocked target is returned as the bridge failure, not retried blindly. An uncaught error raised by the handler is returned as runtimeError. Non-secure field values appear in the returned outline; secure fields stay redacted.',
    parameters: actionParameters(),
    async execute(args) {
      return runAction(args);
    },
  });

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(miniappTool),
      ctx.tools.register(uiTool, { when }),
      ctx.tools.register(actionTool, { when }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      delivery.pendingAgents.clear();
      delivery.waiters.clear();
    };
  }, 'jiezi-tools: model-facing tools');

  // Official additive extension point: no `complete`, no assembly rewrite, and
  // no persona replacement. Cordis owns cleanup within this preset's scope.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'jiezi-delivery',
    order: 40,
    text: promptSection(),
    interpolate: false,
    retirement: 'The JieZi mini-app development instructions no longer apply.',
  }), 'jiezi-tools: mini-app development prompt');

  ctx.effect(() => {
    let stopped = false;
    let retry = 1_000;
    let timer: NodeJS.Timeout | null = null;
    let stopStream: (() => void) | null = null;

    const schedule = (): void => {
      if (stopped || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        retry = Math.min(retry * 2, 30_000);
        connect();
      }, retry);
      timer.unref?.();
    };

    const connect = (): void => {
      if (stopped) return;
      stopStream = operations.client.openEventStream({
        onEvent(type, payload) {
          retry = 1_000;
          handleEvent(type, payload, delivery);
        },
        onClose() {
          schedule();
        },
      });
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      stopStream?.();
    };
  }, 'jiezi-tools: operation wake-ups');
}

/** Deliver a terminal update to the Agent that started the deploy. */
function handleEvent(
  type: string,
  payload: Record<string, unknown>,
  delivery: DeliveryState,
): void {
  // Evidence normally precedes the terminal status that describes it; waking on
  // the evidence event would race the Agent into diagnostics before the status
  // carries the evidence id. Status is the one wake-up that has the complete
  // terminal record.
  if (type !== 'status') return;
  const opId = typeof payload.opId === 'string' ? payload.opId : null;
  if (opId === null) return;
  const state = typeof payload.state === 'string' ? payload.state : 'running';
  if (!isTerminalState(state)) return;
  const waiting = delivery.waiters.get(opId);
  if (waiting !== undefined) {
    // One blocking status call owns this record. A notice here would
    // duplicate the result that tool is about to return.
    delivery.waiters.delete(opId);
    delivery.pendingAgents.delete(opId);
    for (const resolve of waiting) resolve();
    return;
  }
  const agent = delivery.pendingAgents.get(opId);
  if (agent === undefined) return;
  delivery.pendingAgents.delete(opId);
  const layer = typeof payload.failureLayer === 'string' && FAILURE_LAYERS.has(payload.failureLayer)
    ? payload.failureLayer
    : null;
  const evidence = typeof payload.evidenceId === 'string' ? payload.evidenceId : null;
  const text = [
    `JieZi delivery update for ${opId}: ${STATE_LABEL[state] ?? state}${layer === null ? '' : ` (${layer})`}.`,
    evidence === null ? '' : `Evidence id: ${evidence}.`,
    state === 'failed'
      ? 'Call miniapp with action="diagnostics" and this opId, fix the source when the layer is compile/runtime/load, then build and deploy a new release. Do not retry host-component or refused failures without changing the artifact or host.'
      : 'Call miniapp with action="diagnostics" and this opId to read the captured report. If the app is running, load the jiezi-miniapp skill, then use miniapp_ui and miniapp_action to inspect and tap the current screen.',
  ].filter(Boolean).join(' ');
  if (typeof agent.followup !== 'function') return;
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      // A delivery event is a machine notice, never human input: a `user` source
      // would grant goal authority and reset the repetition guard.
      kind: 'jiezi-delivery',
      form: 'notice',
      summary: boundDeliverySummary(opId, state),
      opId,
      state,
      ...(layer === null ? {} : { failureLayer: layer }),
      ...(evidence === null ? {} : { evidenceId: evidence }),
    },
  };
  try {
    // A busy Agent reads the notice at its next step without spending a turn;
    // only an idle Agent needs the follow-up turn to wake up.
    if (agent.status === 'running' && typeof agent.inject === 'function') agent.inject(message);
    else agent.followup(message);
  } catch {
    // The owning Agent may have been disposed between deploy and event.
  }
}

/** Five hard constraints; procedures and per-action detail live in the skill. */
function promptSection(): string {
  return [
    '## JieZi mini-app development',
    '',
    'These rules supplement the standard Agent guidance; the jiezi-miniapp skill owns the procedure, per-action parameters and repair routing. Load it before the first mini-app action.',
    '',
    '- Boundaries: edit only the project\'s Native Shell TSX, `jiezi.json`, `docs/about.md` and the optional `assets/icon.png`. No npm packages, second toolchain, native code, generated `.nsh` edits, or files outside the project. Never seek or embed credentials, pairing data or signing material; never edit bridge state or DSH profiles.',
    '- Never guess a device or Host target: `miniapp` action=device list/ensure_ready is the only way to pick one. `automation_disabled` is explicit user revocation; do not bypass it.',
    '- Never claim initialization, build, install, action or verification success without the matching observed result. Report unrun checks and blockers as blockers.',
    '- A source-side `JZ_*` refusal is fixed at the source and rebuilt; never retry an unchanged refused artifact. Trust/route refusals (`JZ_UNTRUSTED`, `JZ_DEVELOPMENT_IMPORT`) and Host alerts are reported, never worked around or redeployed. Compile/load/runtime failures go to `miniapp` action=diagnostics.',
    '- A release without `releaseId` is not deployable, and no delivery is complete before the terminal operation status and a fresh `miniapp_ui`/`miniapp_action` observation agree. Both observation tools appear only after `jiezi-miniapp` loads (one step later for a UI-invoked skill).',
  ].join('\n');
}

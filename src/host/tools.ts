/**
 * Preset plugin `dsh-jiezi/tools`.
 *
 * Registers the model-facing delivery tools and the loop prompt section. The
 * tools and the browser panel call the same operations layer (`operations.ts`),
 * so a deploy or automation result has one shape and one set of bounds.
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
}

/** The subset of the preset context this plugin uses. */
interface ToolsContext {
  tools: { register(definition: ToolDefinition): () => void };
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
}

/** Plugin row name reported by the loader. */
export const name = 'jiezi-tools';

/** Tools and prompt text are the only contributions. */
export const inject = ['tools', 'systemPrompt'];

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

/** One pending terminal-status wake for a blocking `miniapp_status` call. */
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

/**
 * Register the fourteen project/delivery/lifecycle tools and the prompt section on the preset
 * context. Any operation failure becomes a structured tool result; only a
 * throw from the registration itself propagates.
 */
export function apply(ctx: ToolsContext, config: unknown = {}): void {
  const settings = resolveBridgeSettings(config);
  const operations = getSharedOperations(settings);
  const delivery: DeliveryState = { pendingAgents: new Map(), waiters: new Map() };
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

  const tools: ToolDefinition[] = [
    tool({
      name: 'miniapp_init',
      description: 'Initialize a new JieZi Native Shell TSX mini-app in the Session working directory (or in <working directory>/<projectId> when the profile sets projectLayout: named-subdirectory). Runs the pinned non-interactive TSX scaffold, adds a tested counter template with stable testIDs, and stages the bundled jiezi/native adapter. projectId is a lowercase slug; name and reverse-DNS appId are optional. Never overwrites a non-empty destination. Returns projectId, projectDir, and signing { certificate, signable } for subsequent editing and miniapp_build.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'New lowercase project slug, 1–48 chars; it names the project, not a directory. The default layout initializes the empty Session working directory itself.' },
          name: { type: 'string', description: 'Optional display name, 1–80 printable characters.' },
          appId: { type: 'string', description: 'Optional reverse-DNS app id; defaults to com.jiezi.miniapp.<slug without hyphens>.' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        return operations.init(args, sessionRoot(exec));
      },
    }),
    tool({
      name: 'miniapp_build',
      description: 'Build a Native Shell mini-app project on the DSH computer. Returns a release id, build number, artifact path, and SHA-256, or structured compile errors pointing at source lines.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id; the default project directory is the Session working directory itself.' },
          projectDir: { type: 'string', description: 'Absolute project directory when it is not the configured default; a project created earlier under the bridge root still builds.' },
        },
        required: ['projectId'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        return operations.build(args, sessionRoot(exec));
      },
    }),
    tool({
      name: 'miniapp_deploy',
      description: 'Queue a built release for one paired device. Returns an operation id immediately; pass it to miniapp_status with wait: true to block for the terminal result, or let the terminal status wake this Agent. A repeated (releaseId, deviceId) is deduplicated and does not reinstall; use force:true or miniapp_reload to clear a stuck instance or Host alert.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          releaseId: { type: 'string', description: 'Release id returned by miniapp_build.' },
          force: { type: 'boolean', description: 'Start a fresh install/launch operation for the same release instead of reusing the deduplicated one. Use for a stuck instance or a blocking Host alert.' },
        },
        required: ['deviceId', 'releaseId'],
        additionalProperties: false,
      },
      async execute(args, exec) {
        const result = await operations.deploy(args);
        const opId = typeof result.opId === 'string' ? result.opId : null;
        if (result.ok !== false && opId !== null && exec?.agent !== undefined) {
          delivery.pendingAgents.set(opId, exec.agent);
        }
        return result;
      },
    }),
    tool({
      name: 'miniapp_status',
      description: 'Read one delivery operation, or the recent operations for a device. With opId and wait: true, block until that operation reaches running or failed, or timeoutMs expires. Terminal states are running and failed. running means the new instance of that build started and no runtime error appeared during the startup settle window; a failed operation names its failure layer and evidence.',
      parameters: {
        type: 'object',
        properties: {
          opId: { type: 'string', description: 'Operation id from miniapp_deploy.' },
          deviceId: { type: 'string', description: 'List recent operations for this device instead.' },
          wait: { type: 'boolean', description: 'Block until this operation reaches running or failed; requires opId. A timed-out wait leaves the operation running. Defaults to false.' },
          timeoutMs: { type: 'integer', description: `How long a wait may take, 1000 to ${MAX_STATUS_WAIT_MS}; defaults to ${DEFAULT_STATUS_WAIT_MS}.` },
        },
        additionalProperties: false,
      },
      async execute(args, exec) {
        const opId = typeof args.opId === 'string' ? args.opId : undefined;
        const deviceId = typeof args.deviceId === 'string' ? args.deviceId : undefined;
        const attachHost = async (result: Record<string, unknown>): Promise<Record<string, unknown>> => {
          const op = result.op !== null && typeof result.op === 'object' && !Array.isArray(result.op)
            ? result.op as Record<string, unknown>
            : null;
          const opDeviceId = op !== null && typeof op.deviceId === 'string' ? op.deviceId : null;
          if (opDeviceId === null) return result;
          return { ...result, host: await operations.hostInfo(opDeviceId) };
        };
        if (args.wait === true) {
          if (opId === undefined) throw new JieZiError('invalid_request', 'wait requires opId');
          return attachHost(await waitForOperation(opId, statusWaitTimeout(args.timeoutMs), exec?.signal));
        }
        return attachHost(await operations.operation({
          ...(opId === undefined ? {} : { opId }),
          ...(deviceId === undefined ? {} : { deviceId }),
        }));
      },
    }),
    tool({
      name: 'miniapp_diagnostics',
      description: 'Read the bounded diagnostics for a delivery operation or evidence id. Returns the failure layer, a short summary, counts, and a file path; event bodies and screenshots stay on disk.',
      parameters: {
        type: 'object',
        properties: {
          opId: { type: 'string', description: 'Operation id; its latest evidence is read.' },
          evidenceId: { type: 'string', description: 'Evidence id from a status wake-up or miniapp_status.' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        return operations.diagnostics(args);
      },
    }),
    tool({
      name: 'miniapp_reload',
      description: 'Reinstall and relaunch the current release with a fresh operation id. This is the supported way to clear a Host alert or a stuck instance without changing source. Omit releaseId to use the active or installed release. Returns an operation id; wait with miniapp_status.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          releaseId: { type: 'string', description: 'Release to reinstall; defaults to the device active release.' },
          appId: { type: 'string', description: 'Select the installed app whose release should be reloaded when releaseId is omitted.' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      async execute(args) {
        return operations.reload(args);
      },
    }),
    tool({
      name: 'miniapp_doctor',
      description: 'One-call readiness check for the JieZi environment: bridge identity/version, nsh toolchain, Host version and compatibility, pairing, and developer automation. Returns ready, blockers, and nextActions. Use fix:true only to rewrite a stale nsh path and restart a stale bridge; it never initializes trust, pairs, or launches the Host.',
      parameters: {
        type: 'object',
        properties: {
          fix: { type: 'boolean', description: 'Apply the safe repairs (stale nshPath, stale bridge restart). Defaults to false.' },
        },
        additionalProperties: false,
      },
      async execute(args) {
        return operations.doctor(args);
      },
    }),
    tool({
      name: 'miniapp_capture',
      description: 'Ask a connected device for one page tree or screenshot and wait briefly for the result. Returns the tree and screenshot path when the device answers; a pending result can be read again by passing its requestId.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          waitMs: { type: 'integer', description: 'How long to wait for the device, from 0 to 15000; defaults to 5000.' },
          requestId: { type: 'string', description: 'A pending capture request id to read again instead of starting a new capture.' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      async execute(args) {
        const result = await operations.capture(args);
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
          note: result.note ?? 'The page tree exceeded the inline bound; use miniapp_ui for semantic nodes or the screenshot path for pixels.',
        };
      },
    }),
    tool({
      name: 'miniapp_open',
      description: 'Open one already installed mini-app by appId after a Host restart, without tapping the Host application library and without downloading an artifact. It never restarts or reloads a running instance; use miniapp_reload for a stuck instance or blocking Host alert. Returns the running instance id or the bridge/host failure.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          appId: { type: 'string', description: 'Installed mini-app id, for example from miniapp_devices.activeApp.installedApps.' },
          timeoutMs: { type: 'integer', description: 'How long to wait for the app to report running, 1000 to 30000; defaults to 15000.' },
        },
        required: ['deviceId', 'appId'],
        additionalProperties: false,
      },
      async execute(args) {
        return operations.open(args);
      },
    }),
    tool({
      name: 'miniapp_screen',
      description: 'Capture the complete device screen through the DSH computer (simctl or devicectl) and return a local PNG path. Unlike miniapp_capture, this includes the status bar, presented modal layers and the Host chrome, and it works when no mini-app is active. The image itself is not returned.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          hostDeviceId: { type: 'string', description: 'Optional CoreDevice/simulator UDID to override the remembered binding.' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      async execute(args) {
        return operations.screen(args);
      },
    }),
    tool({
      name: 'miniapp_devices',
      description: 'List paired devices with one schema shared by miniapp_device list: online, developer-mode, automation, active mini-app, jieziPaired/coreDevicePaired/hostRunning, Host version and compatibility, binding, CoreDevice targets, and one next action. Also works before bridge pairing to show launchable CoreDevice targets.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return operations.device({ action: 'list' });
      },
    }),
    tool({
      name: 'miniapp_device',
      description: 'Inspect or recover the developer loop. list shows paired devices, CoreDevice/simulator targets and bindings. launch_host starts the installed JieZi App with no paired deviceId (by hostDeviceId, a binding, or the only eligible target). ensure_ready starts the configured bridge, binds a host UDID once, launches the installed JieZi App without terminating it, and verifies developer automation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'ensure_ready', 'launch_host'], description: 'List lifecycle state, launch the Host, or recover one paired device.' },
          deviceId: { type: 'string', description: 'Paired device id from miniapp_devices; required for ensure_ready and optional for launch_host.' },
          hostDeviceId: { type: 'string', description: 'CoreDevice/simulator UDID for the first binding or an explicit rebind.' },
          rebind: { type: 'boolean', description: 'Must be true to replace an existing hostDeviceId binding.' },
          waitMs: { type: 'integer', description: 'Readiness timeout from 1000 to 90000ms; defaults to 30000.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(args) {
        return operations.device(args);
      },
    }),
    tool({
      name: 'miniapp_ui',
      description: 'Read the current mini-app screen as a bounded semantic outline. Returns aliases, testIDs, labels, roles, paths, and a diagnostic cursor that miniapp_action can target. Requires a connected device with developer automation enabled.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
          opId: { type: 'string', description: 'Idempotency id; omit to generate one for this call.' },
          appId: { type: 'string', description: 'Expected active mini-app id; mismatches fail instead of observing another app.' },
          instanceId: { type: 'string', description: 'Expected mini-app instance id.' },
          snapshotId: { type: 'string', description: 'Snapshot id to read again.' },
          diagnosticCursor: { type: 'integer', description: 'Diagnostic cursor from a previous snapshot.' },
          includeFrames: { type: 'boolean', description: 'Include each visible node frame and the screen size in the outline; defaults to false.' },
          includeHidden: { type: 'boolean', description: 'Include hidden accessibility nodes; defaults to false because recycled list rows can duplicate a testID.' },
          timeoutMs: { type: 'integer', description: 'How long the device may take, 1000 to 30000; defaults to 15000.' },
        },
        required: ['deviceId'],
        additionalProperties: false,
      },
      async execute(args) {
        return automationToolResult(await operations.startAutomation({
          ...args,
          action: 'observe',
          opId: automationOpId(args),
        }));
      },
    }),
    tool({
      name: 'miniapp_action',
      description: 'Tap one unique visible control, type into one text field, or scroll the nearest scroll view, in the current mini-app by testID, label, role, alias, or path. Returns the new bounded outline (including modal-dialog nodes and focused non-secure text values), verification result, and diagnostic events from this action. A missing, ambiguous, disabled, stale, non-input, or alert-blocked target is returned as the bridge failure, not retried blindly. An uncaught error raised by the handler is returned as runtimeError.',
      parameters: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Target device from miniapp_devices.' },
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
          text: { type: 'string', description: 'Text to write for action=type, up to 1024 characters. Non-secure field values appear in the returned outline; secure fields stay redacted.' },
          replace: { type: 'boolean', description: 'For action=type, replace the field text (default true) or append at the caret (false).' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'For action=scroll, the content direction; defaults to down.' },
          amount: { type: 'number', description: 'For action=scroll, the fraction of the viewport to move, 0.1 to 1; defaults to 0.8.' },
          expect: {
            type: 'object',
            description: 'Post-action assertion evaluated by the shared operations layer after the device returns a fresh snapshot. Conditions are ANDed; use checks to assert several scoped testIDs or texts in one call.',
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
      },
      async execute(args) {
        const action: AutomationAction = args.action === 'type'
          ? 'type'
          : args.action === 'scroll'
            ? 'scroll'
            : 'tap';
        const request = parseAutomationArgs(action, { ...args, opId: automationOpId(args) });
        return automationToolResult(await operations.automation(request));
      },
    }),
  ];

  ctx.effect(() => {
    const disposers = tools.map((definition) => ctx.tools.register(definition));
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
    // One blocking miniapp_status call owns this record. A notice here would
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
      ? 'Call miniapp_diagnostics with this opId, fix the source when the layer is compile/runtime/load, then build and deploy a new release. Do not retry host-component or refused failures without changing the artifact or host.'
      : 'Call miniapp_diagnostics with this opId to read the captured report. If the app is running, miniapp_ui and miniapp_action can inspect and tap the current screen.',
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

/** Always-on JieZi policy; detailed procedures remain in the bundled skill. */
function promptSection(): string {
  return [
    '## JieZi mini-app development',
    '',
    'These rules supplement the standard Agent guidance. Use the normal coding tools for inspection and edits, and the JieZi tools for project initialization, delivery, and device evidence.',
    '',
    '### Project and component rules',
    '- Work on Native Shell TSX in the Session working directory. If no project exists, call miniapp_init once with a lowercase projectId; it initializes the working directory itself by default (or <working directory>/<projectId> with projectLayout: named-subdirectory), so use its returned projectDir. It creates the official TSX scaffold, a tested counter template, and the staged native adapter. Never initialize over or overwrite existing work.',
    '- miniapp_init reports signing.signable for the development certificate. When it is false, tell the user that appId before any build instead of discovering the refusal at signing; the default com.jiezi.miniapp.<slug> id is signable.',
    '- Use the read, glob, and grep tools for inspection. Reach for bash only for a command that genuinely needs a shell (nsh test/check, shasum, device tooling), never as a substitute for those three.',
    '- Do not add npm packages, another package manager, React Native/DOM code, native code, or app-side Rust/Cargo setup. The reviewed jiezi/native components are registered by current Hosts and need no per-app grant; a new native capability requires a Host release and explicit user approval.',
    '- Before choosing or using components, load the jiezi-miniapp skill and read components.md plus its bundled API snapshot. These resources work in an empty workspace and do not depend on a JieZi checkout. After initialization, reconcile project-version differences; use host.params.components for runtime Host availability. miniapp_ui capabilities are automation actions, not a component catalog.',
    '- Give screens, controls, and important result/error states stable unique testIDs. Keep capabilities minimal and never embed or seek provider, pairing, or signing credentials.',
    '',
    '### Required implementation and verification loop',
    '- If the environment is uncertain (first call, nsh/Host version, no devices), call miniapp_doctor once. It returns ready, blockers, and nextActions. Use fix:true only for a stale nsh path or bridge restart. Do not guess a host target.',
    '- For a new app: miniapp_init → edit → miniapp_build. For later changes: inspect/read evidence → edit → miniapp_build. A deployable build requires ok:true and a releaseId; failed builds have no deployable release.',
    '- Deploy the exact successful release with miniapp_deploy, then immediately call miniapp_status with { opId, wait: true }. Do not end the turn or poll rapidly. On timeout, read the same opId again rather than duplicating deployment.',
    '- A deploy result with deduplicated:true/reinstalled:false did not start a new install. Do not redeploy the same release hoping to change the screen; use miniapp_reload (or miniapp_deploy force:true) only when the instance is stuck or a Host alert blocks automation.',
    '- running proves only that the exact build launched without a startup-settle runtime error. It does not prove the requested interaction, persistence, or layout.',
    '- Verify key flows with miniapp_ui and miniapp_action using fresh unique targets and expect assertions. Prefer expect.checks when one action must assert both progress and hint text. Hidden nodes are omitted by default; do not set includeHidden unless debugging recycled rows. Inspect state, error, verification.passed, diagnostics, snapshotIssues, Host alerts, host.version, and runtimeError even when the envelope is ok:true. Use miniapp_screen or miniapp_capture for visual evidence and actually read the image before making visual claims.',
    '- HOST_ALERT_BLOCKING is a Host App layer issue, not a mini-app runtime error: do not rebuild or redeploy the same release. The alert carries the Host version; if it is older than host.minimumVersion, ask for a Host update or tell the user to tap 继续. runtimeError is separate.',
    '- miniapp_open only opens an installed app when no instance is running. It never restarts a live instance; use miniapp_reload for that.',
    '- For failed build/runtime behavior, use miniapp_diagnostics with the opId or evidenceId and keep evidence scoped to that app instance. Repair compile/load/runtime source issues; check Host support for host-component; never retry an unchanged refused artifact. After a source fix, repeat build → deploy → blocking status → semantic verification.',
    '',
    '### Device and user boundaries',
    '- The user pairs once through the JieZi sidebar and iPhone. miniapp_device list/launch_host/ensure_ready inspects and recovers the configured bridge/Host; never guess among multiple host targets. jieziPaired, coreDevicePaired, and hostRunning are different facts.',
    '- automation_disabled is explicit user revocation: stop and ask for user action if desired. Do not re-enable it through another channel. Pairing, unlock, trust, and missing Host installation can remain user blockers.',
    '- Do not edit bridge state, DSH profiles, signing keys, or files outside the project. Do not claim initialization, build, install, action, or verification success without the corresponding observed result; report unrun checks and blockers explicitly.',
  ].join('\n');
}

/**
 * Shared error vocabulary for the JieZi Host routes, the model-facing tools, and
 * the browser panel.
 *
 * Every failure that leaves the Host API is one JSON object
 * `{ ok: false, error: { code, message, retryable } }`. Codes stay stable so the
 * panel and the Agent can act on them; messages are short and actionable.
 */

/** Stable failure codes shared by Host routes and tools. */
export type JieZiErrorCode =
  | 'invalid_request'
  | 'body_too_large'
  | 'bridge_unavailable'
  | 'bridge_timeout'
  | 'bridge_protocol'
  | 'not_paired'
  | 'device_offline'
  | 'unknown_release'
  | 'unknown_op'
  | 'unknown_evidence'
  | 'unknown_open'
  | 'pairing_expired'
  | 'pairing_used'
  | 'unknown_pairing_session'
  | 'automation_unavailable'
  | 'automation_disabled'
  | 'open_unavailable'
  | 'host_binding_required'
  | 'host_launch_failed'
  | 'screen_capture_failed'
  | 'device_not_ready'
  | 'bridge_not_configured'
  | 'bridge_version_mismatch'
  | 'bridge_identity_mismatch'
  | 'consent_required'
  | 'nsh_missing'
  | 'setup_failed'
  | 'app_not_active'
  | 'stale_instance'
  | 'op_conflict'
  | 'outside_project_root'
  | 'project_exists'
  | 'init_failed'
  | 'build_failed'
  | 'busy'
  | 'unsupported'
  | 'unauthorized'
  | 'internal';

/** Failure thrown inside Host code and serialized at one boundary. */
export class JieZiError extends Error {
  readonly code: JieZiErrorCode;
  readonly retryable: boolean;

  constructor(code: JieZiErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JieZiError';
    this.code = code;
    this.retryable = options.retryable ?? (code === 'bridge_unavailable' || code === 'bridge_timeout' || code === 'device_offline' || code === 'host_launch_failed' || code === 'screen_capture_failed' || code === 'device_not_ready');
  }
}

/** Raised for a malformed argument or body. */
export function invalid(message: string): JieZiError {
  return new JieZiError('invalid_request', message);
}

/** One public failure body. */
export interface PublicErrorBody {
  ok: false;
  error: {
    code: JieZiErrorCode;
    message: string;
    retryable: boolean;
  };
}

/** Convert any thrown value into the public JSON failure body. */
export function toPublicError(error: unknown): PublicErrorBody {
  if (error instanceof JieZiError) {
    return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'internal', message: message.slice(0, 500), retryable: false } };
}

/** HTTP status chosen for a failure code. */
export function httpStatusFor(code: JieZiErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400;
    case 'consent_required':
      return 400;
    case 'body_too_large':
      return 413;
    case 'unauthorized':
      return 401;
    case 'bridge_unavailable':
    case 'bridge_timeout':
      return 503;
    case 'device_offline':
    case 'not_paired':
    case 'unknown_release':
    case 'unknown_op':
    case 'unknown_evidence':
    case 'unknown_open':
    case 'unknown_pairing_session':
    case 'pairing_expired':
    case 'pairing_used':
    case 'automation_unavailable':
    case 'automation_disabled':
    case 'open_unavailable':
    case 'host_binding_required':
    case 'host_launch_failed':
    case 'screen_capture_failed':
    case 'device_not_ready':
    case 'bridge_not_configured':
    case 'bridge_version_mismatch':
    case 'bridge_identity_mismatch':
    case 'nsh_missing':
    case 'setup_failed':
    case 'app_not_active':
    case 'stale_instance':
    case 'op_conflict':
    case 'outside_project_root':
    case 'project_exists':
    case 'init_failed':
    case 'build_failed':
    case 'busy':
      return 409;
    case 'unsupported':
      return 501;
    case 'bridge_protocol':
    case 'internal':
      return 500;
  }
}

/**
 * Map a bridge error code onto the shared vocabulary when the names differ.
 * Unknown bridge codes pass through unchanged as `bridge_protocol` only when
 * they are not part of the public set, so a caller still gets a useful code.
 */
const KNOWN_CODES = new Set<JieZiErrorCode>([
  'invalid_request', 'body_too_large', 'bridge_unavailable', 'bridge_timeout', 'bridge_protocol',
  'not_paired', 'device_offline', 'unknown_release', 'unknown_op', 'unknown_evidence', 'unknown_open',
  'pairing_expired', 'pairing_used', 'unknown_pairing_session', 'automation_unavailable',
  'automation_disabled', 'open_unavailable', 'host_binding_required', 'host_launch_failed', 'screen_capture_failed', 'device_not_ready',
  'bridge_not_configured', 'bridge_version_mismatch', 'bridge_identity_mismatch', 'consent_required', 'nsh_missing', 'setup_failed',
  'app_not_active', 'stale_instance', 'op_conflict', 'outside_project_root', 'project_exists', 'init_failed', 'build_failed',
  'busy', 'unsupported', 'unauthorized', 'internal',
]);

/** Narrow a bridge-supplied code to a public code. */
export function knownCode(code: unknown): JieZiErrorCode {
  return typeof code === 'string' && KNOWN_CODES.has(code as JieZiErrorCode)
    ? code as JieZiErrorCode
    : 'bridge_protocol';
}

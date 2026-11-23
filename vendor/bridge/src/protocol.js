// Wire protocol primitives shared by the bridge, the tools, and the mock
// device. No I/O here, so the rules can be tested in isolation.

import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024;
export const MAX_EVIDENCE_EVENTS = 200;
export const MAX_STRING_CHARS = 64 * 1024;
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

export const STATES = [
  'pending',
  'downloading',
  'verifying',
  'installing',
  'launching',
  'running',
  'failed',
];

const TRANSITIONS = {
  pending: ['downloading', 'failed'],
  downloading: ['verifying', 'failed'],
  verifying: ['installing', 'failed'],
  installing: ['launching', 'failed'],
  launching: ['running', 'failed'],
  running: ['failed'],
  failed: [],
};

export const FAILURE_LAYERS = [
  'compile',
  'load',
  'runtime',
  'host-component',
  'refused',
  'timeout',
];

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashToken(token) {
  return sha256(`jiezi-device-token\u0000${token}`);
}

export function equalHash(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function opIdFor(releaseId, deviceId) {
  return `op_${sha256(`${releaseId}\n${deviceId}`).slice(0, 16)}`;
}

export function evidenceIdFor(report) {
  return `ev_${sha256(JSON.stringify(report)).slice(0, 16)}`;
}

export function isState(value) {
  return STATES.includes(value);
}

export function isTerminal(state) {
  return state === 'running' || state === 'failed';
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertEnvelope(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new ProtocolError('invalid_request', 'message must be an object');
  }
  if (message.v !== PROTOCOL_VERSION) {
    throw new ProtocolError('invalid_request', `unsupported protocol version: ${String(message.v)}`);
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    throw new ProtocolError('invalid_request', 'message.type must be a non-empty string');
  }
  if (message.payload !== undefined && (message.payload === null || typeof message.payload !== 'object')) {
    throw new ProtocolError('invalid_request', 'message.payload must be an object');
  }
  return message.payload ?? {};
}

export class ProtocolError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function envelope(type, payload, id = cryptoRandomId()) {
  return { v: PROTOCOL_VERSION, id, type, ts: new Date().toISOString(), payload };
}

function cryptoRandomId() {
  return `msg_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// Bound an incoming diagnostics report without changing its declared schema.
// Event arrays are trimmed first; long strings are clipped; an unmanageable
// report is replaced by a small stub that names the original size.
export function boundReport(input, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_REPORT_BYTES;
  const maxEvents = options.maxEvents ?? MAX_EVIDENCE_EVENTS;
  const maxString = options.maxString ?? MAX_STRING_CHARS;

  let report;
  try {
    report = JSON.parse(JSON.stringify(input));
  } catch {
    throw new ProtocolError('invalid_request', 'report must be lossless JSON');
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new ProtocolError('invalid_request', 'report must be an object');
  }

  let droppedEvents = 0;
  let seenEvents = 0;
  const sessions = Array.isArray(report.sessions) ? report.sessions : null;
  if (sessions) {
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      if (Array.isArray(session.events)) {
        const kept = [];
        for (const event of session.events) {
          if (seenEvents >= maxEvents) {
            droppedEvents += 1;
            continue;
          }
          kept.push(event);
          seenEvents += 1;
        }
        session.events = kept;
      }
    }
  }
  if (Array.isArray(report.events)) {
    const kept = [];
    for (const event of report.events) {
      if (seenEvents >= maxEvents) {
        droppedEvents += 1;
        continue;
      }
      kept.push(event);
      seenEvents += 1;
    }
    report.events = kept;
  }

  clipStrings(report, maxString);

  let serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > maxBytes) {
    // Last resort: drop event bodies but keep the session identity and counts.
    if (sessions) {
      for (const session of sessions) {
        if (Array.isArray(session.events) && session.events.length > 0) {
          droppedEvents += session.events.length;
          session.events = [];
        }
      }
    }
    if (Array.isArray(report.events)) {
      droppedEvents += report.events.length;
      report.events = [];
    }
    report.truncated = true;
    report.droppedEvents = droppedEvents;
    serialized = JSON.stringify(report);
  }

  if (Buffer.byteLength(serialized) > maxBytes) {
    const stub = {
      schema: typeof report.schema === 'string' ? report.schema : 'jiezi.diagnostics.v1',
      schemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      truncated: true,
      droppedEvents,
      originalBytes: Buffer.byteLength(serialized),
      note: 'report exceeded the bridge evidence bound; full report was not accepted',
    };
    return { report: stub, truncated: true, droppedEvents, bytes: Buffer.byteLength(JSON.stringify(stub)) };
  }

  if (droppedEvents > 0) {
    report.truncated = true;
    report.droppedEvents = droppedEvents;
    serialized = JSON.stringify(report);
  }
  return {
    report,
    truncated: droppedEvents > 0,
    droppedEvents,
    bytes: Buffer.byteLength(serialized),
  };
}

function clipStrings(value, maxString) {
  if (typeof value === 'string') {
    return value.length <= maxString ? value : `${value.slice(0, maxString)}…`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = clipStrings(value[i], maxString);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = clipStrings(value[key], maxString);
  }
  return value;
}

export function classifyFailure(error) {
  if (!error || typeof error !== 'object') return 'runtime';
  if (FAILURE_LAYERS.includes(error.layer)) return error.layer;
  const code = String(error.code ?? '');
  if (code.includes('SIGNATURE') || code.includes('COMPAT') || code.includes('REFUSED')) return 'refused';
  if (code.includes('TIMEOUT')) return 'timeout';
  if (code.includes('COMPILE')) return 'compile';
  if (code.includes('LOAD')) return 'load';
  if (code.includes('HOST')) return 'host-component';
  return 'runtime';
}

// Parse the human-readable compiler output of `nsh build` / `nsh publish`.
// Two shapes are recognized: tsc's `file(line,col): error TS…` and Oxc's
// block form (`error building <file> failed`, then `,-[line:col]`).
export function parseBuildErrors(stderr, fallbackFile = 'App.tsx') {
  const text = String(stderr ?? '');
  const errors = [];
  const seen = new Set();
  const push = (file, line, column, message) => {
    const key = `${file}:${line}:${column}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push({ file, line, column, message });
  };

  for (const match of text.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
    push(match[1], Number(match[2]), Number(match[3]), `${match[4]}: ${match[5].trim()}`);
  }
  for (const match of text.matchAll(/^(.+?):(\d+):(\d+):\s*(?:error:?\s*)?(.+)$/gm)) {
    if (match[1].includes(' ')) continue;
    push(match[1], Number(match[2]), Number(match[3]), match[4].trim());
  }

  const lines = text.split(/\r?\n/);
  let currentFile = fallbackFile;
  let currentMessage = '';
  let sourceLine = null;
  let sourceText = '';
  let caretColumn = null;
  let pipeIndex = null;
  let suppressBlock = false;

  const flushBlock = () => {
    if (!suppressBlock && sourceLine !== null && caretColumn !== null) {
      if (!currentMessage) currentMessage = 'compilation failed';
      push(currentFile, sourceLine, caretColumn, currentMessage);
    }
    sourceLine = null;
    sourceText = '';
    caretColumn = null;
    pipeIndex = null;
  };

  for (const line of lines) {
    const building = line.match(/^error building (.+?) failed$/);
    if (building) {
      flushBlock();
      currentFile = building[1];
      currentMessage = '';
      continue;
    }
    const marker = line.match(/^\s*[`,]-\[(\d+):(\d+)\]/);
    if (marker) {
      if (!currentMessage) currentMessage = 'compilation failed';
      push(currentFile, Number(marker[1]), Number(marker[2]), currentMessage);
      sourceLine = null;
      suppressBlock = true;
      continue;
    }
    const codeLine = line.match(/^\s*(\d+)\s*\|\s?(.*)$/);
    if (codeLine) {
      if (suppressBlock) continue;
      sourceLine = Number(codeLine[1]);
      sourceText = codeLine[2];
      pipeIndex = line.indexOf('|');
      caretColumn = null;
      continue;
    }
    const caret = line.match(/^\s*:\s*(\^+)/);
    if (caret && sourceLine !== null && pipeIndex !== null) {
      caretColumn = Math.max(1, line.indexOf('^') - pipeIndex);
      continue;
    }
    if (/^\s*`----/.test(line)) {
      suppressBlock = false;
      flushBlock();
    }
    const message = line.match(/^\s*x\s+(.+)$/);
    if (message) currentMessage = message[1].trim();
  }
  flushBlock();

  return errors;
}

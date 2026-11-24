// `.jz` v1 constants, limits and refusal helpers.
//
// A `.jz` file is a strict ZIP container with a fixed allowlist. This module is
// the single place the wire strings exist so the writer, the reader and the
// tests cannot drift apart.

export const JZ_FORMAT = 'jiezi.miniapp';
export const JZ_FORMAT_VERSION = 1;
export const JZ_MIME = 'application/vnd.jiezi.miniapp+zip';
export const JZ_EXTENSION = '.jz';
export const JZ_SIGNATURE_FORMAT = 'jiezi.signature';
export const JZ_SIGNATURE_VERSION = 1;
export const JZ_SIGNATURE_ALGORITHM = 'Ed25519';
export const JZ_SIGNATURE_CONTEXT = 'jiezi.miniapp.manifest.v1';

export const JZ_ENTRY = Object.freeze({
  manifest: 'manifest.json',
  payload: 'payload/app.nshpkg',
  description: 'docs/about.md',
  icon: 'assets/icon.png',
  signature: 'signatures/jiezi.sig',
});

/** Required entries in canonical order; the icon is optional. */
export const JZ_REQUIRED_ENTRIES = Object.freeze([
  JZ_ENTRY.payload,
  JZ_ENTRY.description,
  JZ_ENTRY.manifest,
  JZ_ENTRY.signature,
]);

export const JZ_ALL_ENTRIES = Object.freeze([
  JZ_ENTRY.icon,
  JZ_ENTRY.payload,
  JZ_ENTRY.description,
  JZ_ENTRY.manifest,
  JZ_ENTRY.signature,
]);

export const JZ_LIMITS = Object.freeze({
  package: 40 * 1024 * 1024,
  aggregate: 40 * 1024 * 1024,
  payload: 32 * 1024 * 1024,
  icon: 2 * 1024 * 1024,
  description: 64 * 1024,
  manifest: 64 * 1024,
  signature: 64 * 1024,
  entries: 5,
  summaryScalars: 120,
  purposeScalars: 240,
  versionScalars: 32,
  nameScalars: 120,
});

export const JZ_CODES = Object.freeze([
  'JZ_BAD_ARCHIVE',
  'JZ_UNKNOWN_ENTRY',
  'JZ_LIMIT_EXCEEDED',
  'JZ_BAD_MANIFEST',
  'JZ_UNSUPPORTED_FORMAT',
  'JZ_CRITICAL_FIELD',
  'JZ_UNTRUSTED',
  'JZ_BAD_SIGNATURE',
  'JZ_HASH_MISMATCH',
  'JZ_BAD_ICON',
  'JZ_BAD_DESCRIPTION',
  'JZ_MISSING_PURPOSE',
  'JZ_UNKNOWN_PURPOSE',
  'JZ_PAYLOAD_MISMATCH',
  'JZ_DEVELOPMENT_IMPORT',
  'JZ_BUILD_CONFLICT',
]);

/**
 * Capabilities whose use needs an authored purpose (034 plan D1). This is the
 * NSH 0.6.0 consent-relevant subset of the 16 accepted capability ids and
 * mirrors the iOS host's `HostPolicy` rules marked sensitive; a test pins the
 * exact list on both sides. `host` and the remaining NSH ids are presentation
 * data here and need no purpose.
 */
export const JZ_SENSITIVE_CAPABILITIES = Object.freeze([
  'clipboard',
  'picker',
  'share',
  'speech',
  'notifications',
]);

export class JZError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JZError';
    this.code = code;
  }
}

export function jzError(code, message) {
  if (!JZ_CODES.includes(code)) throw new Error(`unregistered .jz code: ${code}`);
  return new JZError(code, message);
}

/** Per-entry size cap, or null for a name outside the v1 allowlist. */
export function entryLimit(path) {
  switch (path) {
    case JZ_ENTRY.payload: return JZ_LIMITS.payload;
    case JZ_ENTRY.icon: return JZ_LIMITS.icon;
    case JZ_ENTRY.description: return JZ_LIMITS.description;
    case JZ_ENTRY.manifest: return JZ_LIMITS.manifest;
    case JZ_ENTRY.signature: return JZ_LIMITS.signature;
    default: return null;
  }
}

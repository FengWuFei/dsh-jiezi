// Durable bridge state. Everything is plain JSON with atomic replacement so a
// crash leaves either the old file or the new one, never a partial row.

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: MODE_DIR });
  try {
    chmodSync(path, MODE_DIR);
  } catch {
    // Best effort on platforms that do not model POSIX modes.
  }
}

export function writeJsonAtomic(path, value, mode = MODE_FILE) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temp, path);
}

export function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export class Store {
  constructor(root) {
    this.root = root;
    this.paths = {
      config: join(root, 'config.json'),
      devices: join(root, 'devices.json'),
      pairCode: join(root, 'pair-code.json'),
      ops: join(root, 'ops'),
      artifacts: join(root, 'artifacts'),
      evidence: join(root, 'evidence'),
      captures: join(root, 'captures'),
      screenshots: join(root, 'screenshots'),
      projects: join(root, 'projects'),
      keys: join(root, 'dev-keys'),
      socket: join(root, 'bridge.sock'),
    };
    ensureDir(root);
    for (const path of [this.paths.ops, this.paths.artifacts, this.paths.evidence, this.paths.projects, this.paths.captures, this.paths.screenshots]) {
      ensureDir(path);
    }
  }

  loadConfig() {
    return readJson(this.paths.config, null);
  }

  saveConfig(config) {
    writeJsonAtomic(this.paths.config, config);
  }

  deviceRecords() {
    const data = readJson(this.paths.devices, { devices: {} });
    return data.devices ?? {};
  }

  listDevices() {
    return Object.values(this.deviceRecords())
      .map(({ tokenHash, ...safe }) => safe)
      .sort((a, b) => String(a.pairedAt).localeCompare(String(b.pairedAt)));
  }

  getDevice(deviceId) {
    return this.deviceRecords()[deviceId];
  }

  saveDevice(device) {
    const data = readJson(this.paths.devices, { devices: {} });
    data.devices[device.deviceId] = device;
    writeJsonAtomic(this.paths.devices, data);
  }

  deleteDevice(deviceId) {
    const data = readJson(this.paths.devices, { devices: {} });
    delete data.devices[deviceId];
    writeJsonAtomic(this.paths.devices, data);
  }

  touchDevice(deviceId) {
    const data = readJson(this.paths.devices, { devices: {} });
    const device = data.devices[deviceId];
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    writeJsonAtomic(this.paths.devices, data);
  }

  /** Persist only explicit grant changes, never an accidental disconnect. */
  setDeviceRevocation(deviceId, { developerMode, automation }) {
    const data = readJson(this.paths.devices, { devices: {} });
    const device = data.devices[deviceId];
    if (!device) return;
    if (!developerMode && !automation) delete device.revocation;
    else {
      device.revocation = {
        developerMode: developerMode === true,
        automation: automation === true,
        updatedAt: new Date().toISOString(),
      };
    }
    writeJsonAtomic(this.paths.devices, data);
  }

  setPairCode(code, ttlMs) {
    writeJsonAtomic(this.paths.pairCode, {
      code,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
  }

  readPairCode() {
    return readJson(this.paths.pairCode, null);
  }

  consumePairCode(code) {
    const current = this.readPairCode();
    if (!current) return { ok: false, reason: 'no pairing code was issued' };
    if (Date.parse(current.expiresAt) < Date.now()) return { ok: false, reason: 'pairing code expired' };
    if (current.code !== code) return { ok: false, reason: 'pairing code did not match' };
    writeJsonAtomic(this.paths.pairCode, { code: null, expiresAt: new Date(0).toISOString() });
    return { ok: true };
  }

  opPath(opId) {
    return join(this.paths.ops, `${safeId(opId)}.json`);
  }

  getOp(opId) {
    return readJson(this.opPath(opId), null);
  }

  saveOp(op) {
    writeJsonAtomic(this.opPath(op.opId), op);
  }

  listOps(deviceId) {
    const ops = [];
    for (const name of readdirSync(this.paths.ops)) {
      if (!name.endsWith('.json')) continue;
      const op = readJson(join(this.paths.ops, name), null);
      if (op && (!deviceId || op.deviceId === deviceId)) ops.push(op);
    }
    return ops.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  projectState(projectId) {
    return readJson(join(this.paths.projects, `${safeId(projectId)}.json`), {
      projectId,
      lastBuild: 0,
      releases: {},
    });
  }

  reserveBuild(projectId) {
    const state = this.projectState(projectId);
    state.lastBuild = Number(state.lastBuild ?? 0) + 1;
    writeJsonAtomic(join(this.paths.projects, `${safeId(projectId)}.json`), state);
    return state.lastBuild;
  }

  recordRelease(projectId, release) {
    const state = this.projectState(projectId);
    state.releases[release.releaseId] = release;
    state.lastBuild = Math.max(Number(state.lastBuild ?? 0), release.build);
    writeJsonAtomic(join(this.paths.projects, `${safeId(projectId)}.json`), state);
  }

  saveEvidence(record) {
    writeJsonAtomic(join(this.paths.evidence, `${safeId(record.evidenceId)}.json`), record);
  }

  getEvidence(evidenceId) {
    return readJson(join(this.paths.evidence, `${safeId(evidenceId)}.json`), null);
  }

  artifactPath(releaseId) {
    return join(this.paths.artifacts, `${safeId(releaseId)}.nshpkg`);
  }

  saveCapture(capture) {
    writeJsonAtomic(join(this.paths.captures, `${safeId(capture.requestId)}.json`), capture);
  }

  getCapture(requestId) {
    return readJson(join(this.paths.captures, `${safeId(requestId)}.json`), null);
  }

  saveScreenshot(name, bytes) {
    const path = join(this.paths.screenshots, `${safeId(name)}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  }
}

function safeId(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(text) || text === '.' || text === '..') {
    throw new Error(`unsafe state identifier: ${text}`);
  }
  return text;
}

// Stable identity of one installed bridge copy. The supervisor uses it to tell
// "same version, stale process" (the upgrade path that used to break `nsh`)
// apart from "same code, healthy process" without trusting the version alone.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
let cached = null;

function manifestPath() {
  for (const path of [join(MODULE_DIR, 'package.json'), join(MODULE_DIR, '..', 'package.json')]) {
    if (existsSync(path)) return path;
  }
  throw new Error(`bridge package manifest is missing beside ${MODULE_DIR}`);
}

/**
 * Compute (once) the version, package root, content hash and newest module
 * mtime of this bridge copy. The hash covers every JavaScript module in the
 * same directory, so an in-place upgrade is visible even when the version
 * string did not change.
 */
export function installIdentity() {
  if (cached !== null) return cached;
  const manifest = manifestPath();
  const packageRoot = realpathSync(dirname(manifest));
  const modules = readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
  const digest = createHash('sha256');
  let newestMtimeMs = statSync(manifest).mtimeMs;
  for (const name of modules) {
    const path = join(MODULE_DIR, name);
    digest.update(name);
    digest.update('\u0000');
    digest.update(readFileSync(path));
    digest.update('\u0000');
    const mtime = statSync(path).mtimeMs;
    if (mtime > newestMtimeMs) newestMtimeMs = mtime;
  }
  const version = (() => {
    try {
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      return typeof value.version === 'string' && value.version.length > 0 ? value.version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();
  cached = {
    version,
    packageRoot,
    packageHash: digest.digest('hex').slice(0, 24),
    newestMtimeMs,
    cli: join(MODULE_DIR, 'cli.js'),
  };
  return cached;
}

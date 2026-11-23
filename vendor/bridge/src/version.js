// The bridge version comes from its package.json so the process health
// surface, the socket hello, and the supervisor's expected version cannot
// drift apart. The first lookup is the copied `lib/bridge` layout; the second
// is the source checkout (`src`).
import { readFileSync } from 'node:fs';

function readVersion() {
  for (const path of ['./package.json', '../package.json']) {
    try {
      const value = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      if (typeof value.version === 'string' && value.version.length > 0) return value.version;
    } catch {
      // Try the next layout.
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();

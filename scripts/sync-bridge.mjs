/**
 * Refresh `vendor/bridge` from the JieZi main repository's `companion/bridge`.
 *
 * The bundled bridge is a snapshot, not a second development copy: the plugin
 * pins its exact version in `vendor/bridge/package.json`, and the supervisor
 * restarts only a bridge whose version differs from that file. Copying by hand
 * used to drift, so this script owns the copy and the two renames the public
 * package needs:
 *
 *   - the snapshot's package name becomes `jiezi-bridge`;
 *   - the optional toolchain package prefix becomes `jiezi-nsh`.
 *
 *   node scripts/sync-bridge.mjs --from ../../JieZi/companion/bridge
 */

import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const flag = process.argv.indexOf('--from')
if (flag < 0 || process.argv[flag + 1] === undefined) {
  console.error('usage: node scripts/sync-bridge.mjs --from <path to companion/bridge>')
  process.exit(2)
}
const source = resolve(process.argv[flag + 1])
const target = join(root, 'vendor', 'bridge')

const manifestPath = join(source, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
  throw new Error(`unexpected bridge version in ${manifestPath}`)
}

rmSync(target, { recursive: true, force: true })
for (const relative of ['src', 'templates', 'test']) {
  cpSync(join(source, relative), join(target, relative), { recursive: true })
}

// Every snapshot rename happens here, so a re-sync cannot reintroduce `@local`.
const snapshot = { ...manifest, name: 'jiezi-bridge' }
delete snapshot.scripts
delete snapshot.private
writeFileSync(join(target, 'package.json'), `${JSON.stringify(snapshot, null, 2)}\n`)

const buildPath = join(target, 'src', 'build.js')
const build = readFileSync(buildPath, 'utf8').replace("'@local/jiezi-nsh'", "'jiezi-nsh'")
writeFileSync(buildPath, build)

const files = readdirSync(join(target, 'src')).filter((file) => file.endsWith('.js')).sort()
console.log(`vendor/bridge: jiezi-bridge@${manifest.version}, ${files.length} modules, ${readdirSync(join(target, 'test')).length} tests`)

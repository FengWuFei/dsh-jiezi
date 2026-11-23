/**
 * Pack the optional Native Shell toolchain package from a local `nsh` binary.
 *
 * The 71 MB binary is not committed. This script copies it from the developer's
 * pinned toolchain (the same one the bridge uses), verifies it is executable,
 * and runs `npm pack`; publishing stays an explicit step:
 *
 *   NSH_TOOLCHAIN=/path/to/nsh node scripts/pack-nsh.mjs
 *   npm publish packages/nsh-darwin-arm64 --access public
 *
 * The package version tracks the upstream `nsh` version, not this plugin's.
 */

import { copyFileSync, chmodSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageDir = join(root, 'packages', 'nsh-darwin-arm64')
const binDir = join(packageDir, 'bin')
const destination = join(binDir, 'nsh')

const candidate = process.env.NSH_TOOLCHAIN ?? process.env.NSH ?? join(homedir(), '.jiezi', 'tooling', 'nsh', 'bin', 'nsh')
if (!existsSync(candidate)) {
  console.error(`nsh not found at ${candidate}; set NSH_TOOLCHAIN to the pinned toolchain binary`)
  process.exit(2)
}

copyFileSync(candidate, destination)
chmodSync(destination, 0o755)
const version = execFileSync(destination, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
const bytes = statSync(destination).size
console.log(`packing nsh ${version} (${(bytes / 1024 / 1024).toFixed(1)} MiB) from ${candidate}`)

for (const file of readdirSync(packageDir)) {
  if (file.endsWith('.tgz')) rmSync(join(packageDir, file))
}
execFileSync('npm', ['pack'], { cwd: packageDir, stdio: 'inherit' })

/**
 * Regenerate `index.json` from what the npm registry actually published.
 *
 * The index is the plugin market entry customers add in DSH ("插件 → 发现 →
 * 添加索引源"). Its version list must match npm exactly: a version here that
 * npm does not have installs nothing, and a stale version sends new users to an
 * old build. Run after `npm publish`:
 *
 *   npm run index
 *
 * The official DSH validator is the single source of truth for the format;
 * anything it rejects fails here instead of reaching a customer.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const INDEX_URL = 'https://raw.githubusercontent.com/FengWuFei/dsh-jiezi/main/index.json'
const REGISTRY = (process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
const root = new URL('..', import.meta.url)
const indexPath = new URL('index.json', root)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const index = JSON.parse(readFileSync(indexPath, 'utf8'))

const plugin = index.plugins?.find((entry) => entry.name === manifest.name)
if (plugin === undefined) throw new Error(`index.json has no entry for ${manifest.name}`)

const response = await fetch(`${REGISTRY}/${manifest.name}`, { headers: { accept: 'application/json' } })
if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${manifest.name}`)
const registry = await response.json()

const version = registry['dist-tags']?.latest
const published = registry.versions?.[version]
if (typeof version !== 'string' || published === undefined) {
  throw new Error(`npm registry lists no latest version for ${manifest.name}`)
}
const publishedAt = registry.time?.[version]
const publishTimestamp = publishedAt === undefined ? Math.floor(Date.now() / 1000) : Math.floor(Date.parse(publishedAt) / 1000)
if (!Number.isFinite(publishTimestamp)) throw new Error(`npm registry has no usable publish time for ${manifest.name}@${version}`)
const engines = published.engines?.dsh

plugin.versions = [{
  version,
  publishTimestamp,
  source: { type: 'npm' },
  engines: typeof engines === 'string' && engines.length > 0 ? { dsh: engines } : {},
}]

// The validator is the format contract; a rejected index never leaves this machine.
parseMarketIndex(index, INDEX_URL)

// Write beside the real file and rename, so a failure cannot leave a half-written index.
const temporary = new URL('index.json.tmp', root)
writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`)
renameSync(temporary, indexPath)

console.log(`index.json: ${manifest.name}@${version} (${new Date(publishTimestamp * 1000).toISOString()})`)

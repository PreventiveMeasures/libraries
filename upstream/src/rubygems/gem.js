import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'

import { assertGem, assertSha256, assertion, isSha256, matches, printable } from '../args.js'
import { absolute, home } from '../cache.js'
import { verifiedDownload } from '../download.js'
import { RUBYGEMS, RUBYGEMS_INDEX, buildUrl, encodeSegment, request } from '../http.js'
import { isGemPlatform, platformOf } from './platform.js'
import { isVersion } from './version.js'

// No expiry: a yanked version keeps its number, so is never pushed again,
// and an unyank restores the same file.
const DIR = 'rubygems/gems'

const assertPlatform = assertion('`ruby` or a platform as RubyGems writes one', (value) => value === 'ruby' || isGemPlatform(value))
const hexOf = (checksum) => checksum.replace(/^sha256=/u, '')
const assertChecksum = assertion('a sha256 in lowercase hex, bare or after `sha256=`', (value) => typeof value === 'string' && isSha256(hexOf(value)))

// The cache entry, `<name>@<version>[-<platform>]`, can't collide: a name
// has no `@`, a version no `-`.
function gemOf(method, name, version, platform) {
  assertGem(method, name, version)
  assertPlatform(method, 'platform', platform)
  const suffix = platform === 'ruby' ? '' : `-${platform}`
  return { name, version, platform, what: `${name}@${version}${suffix}`, file: `${name}-${version}${suffix}.gem` }
}

// `<version>[-<platform>] <deps>|<key:value,...>`, split at the first `-`
// as Bundler does.
const LINE = /^(?<version>[^\s|-]+)(?:-(?<platform>[^\s|]+))? [^|]*\|(?<metadata>.*)$/u

// The compact index, as Bundler reads it: every line after the first `---`,
// each of a version Gem::Version reads, and of a platform as RubyGems 3 or 4
// reads it, so `i686-linux` is `x86-linux` too. grpc's, of 1,500, is 340 KB.
const MAX_INDEX = 16 * 1024 * 1024
const readsAs = (written, platform) => written === platform || (written !== 'ruby' && platform !== 'ruby' && (platformOf(written, 3) === platform || platformOf(written, 4) === platform))
async function getChecksum(method, { name, version, platform, what }) {
  const text = await request(buildUrl(RUBYGEMS_INDEX, ['info', name]), { as: 'text' })
  assert.ok(text.length <= MAX_INDEX, `${method}: the index for ${name} is over ${MAX_INDEX} characters`)
  const lines = text.split('\n')
  while (lines.at(-1) === '') lines.pop()
  const found = []
  for (const line of lines.slice(lines.indexOf('---') + 1)) {
    const match = LINE.exec(line)
    if (match === null || !isVersion(match.groups.version) || match.groups.platform === 'current') {
      assert.fail(`${method}: the index for ${name} has a line that is not a version's: ${printable(line.slice(0, 200))}`)
    }
    if (match.groups.version === version && readsAs(match.groups.platform ?? 'ruby', platform)) found.push(match.groups.metadata)
  }
  assert.ok(found.length > 0, `${method}: the index has no ${what}`)
  assert.ok(found.length === 1, `${method}: the index has ${what} on ${found.length} lines`)
  const checksums = found[0].split(',').filter((pair) => pair.startsWith('checksum:'))
  assert.ok(checksums.length === 1, `${method}: the index has ${checksums.length} checksums for ${what}`)
  const checksum = checksums[0].slice('checksum:'.length)
  assertSha256(method, 'the index checksum', checksum)
  return checksum
}

// Gem.user_dir: <engine>/<ruby version> under ~/.gem and the XDG data dir, as
// RUBY_ENGINE and RbConfig's ruby_version name them, so not a GEM_HOME's gems/.
const isEngine = matches(/^[a-z]{1,32}$/u)
const isRubyVersion = matches(/^\d+(?:\.\d+){0,2}(?:\+\d+)?$/u)
async function userDirs() {
  const base = home()
  if (base === undefined) return []
  const data = absolute(process.env.XDG_DATA_HOME) ?? join(base, '.local', 'share')
  const below = (keep) => async (dir) => (await readdir(dir).catch(() => [])).filter(keep).map((name) => join(dir, name))
  const engines = (await Promise.all([join(base, '.gem'), join(data, 'gem')].map(below(isEngine)))).flat()
  return (await Promise.all(engines.map(below(isRubyVersion)))).flat()
}

// RubyGems' own downloads, in the cache/ of each absolute gem dir: the cwd is
// not ours to read. Gem.default_dir depends on how Ruby was built, so is read
// only as GEM_PATH or GEM_HOME names it.
async function localPaths(file) {
  const { GEM_HOME, GEM_PATH } = process.env
  const named = [...(GEM_PATH ?? '').split(delimiter), GEM_HOME].map(absolute).filter(Boolean).map((dir) => resolve(dir))
  return [...new Set([...named, ...await userDirs()])].map((dir) => join(dir, 'cache', file))
}

export async function verifyChecksum(name, version, platform, checksum) {
  const gem = gemOf('verifyChecksum', name, version, platform)
  assertChecksum('verifyChecksum', 'checksum', checksum)
  const hex = hexOf(checksum)
  const indexed = await getChecksum('verifyChecksum', gem)
  assert.ok(indexed === hex, `verifyChecksum: ${gem.what} is ${indexed} on rubygems.org, not ${hex}`)
}

export async function getGem(name, version, platform, checksum) {
  const gem = gemOf('getGem', name, version, platform)
  if (checksum !== undefined) assertChecksum('getGem', 'checksum', checksum)
  const expected = checksum === undefined ? await getChecksum('getGem', gem) : hexOf(checksum)
  const locate = () => buildUrl(RUBYGEMS, ['gems', encodeSegment(gem.file)])
  return await verifiedDownload({ method: 'getGem', dir: DIR, what: gem.what, ext: 'gem', algorithm: 'sha256', expected, local: await localPaths(gem.file), locate })
}

import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'

import { assertGem, assertSha256, assertion, matches, printable } from '../args.js'
import { absolute, home } from '../cache.js'
import { verifiedDownload } from '../download.js'
import { RUBYGEMS, RUBYGEMS_INDEX, buildUrl, encodeSegment, request } from '../http.js'
import { isGemPlatform } from './platform.js'

// No expiry: a yanked version keeps its number, so is never pushed again,
// and an unyank restores the same file.
const DIR = 'rubygems/gems'

const assertPlatform = assertion('`ruby` or a platform as RubyGems writes one', (value) => value === 'ruby' || isGemPlatform(value))
const assertChecksum = assertion('a sha256 in lowercase hex, bare or after `sha256=`', matches(/^(?:sha256=)?[\da-f]{64}$/u))
const hexOf = (checksum) => checksum.replace(/^sha256=/u, '')

// The cache entry, `<name>@<version>[-<platform>]`, can't collide: a name
// has no `@`, a version no `-`.
function gemOf(method, name, version, platform) {
  assertGem(method, name, version)
  assertPlatform(method, 'platform', platform)
  const suffix = platform === 'ruby' ? '' : `-${platform}`
  return { what: `${name}@${version}${suffix}`, file: `${name}-${version}${suffix}.gem` }
}

// `<version>[-<platform>] <deps>|<key:value,...>`, split at the first `-`
// as Bundler does.
const LINE = /^(?<version>[^\s|-]+)(?:-(?<platform>[^\s|]+))? [^|]*\|(?<metadata>.*)$/u

// The compact index, as Bundler reads it: every line after the first `---`.
async function getChecksum(method, name, version, platform, what) {
  const lines = (await request(buildUrl(RUBYGEMS_INDEX, ['info', name]), { as: 'text' })).split('\n')
  while (lines.at(-1) === '') lines.pop()
  const parse = (line) => {
    const match = LINE.exec(line)
    assert.ok(match, `${method}: the index for ${name} has a line that is not a version's: ${printable(line.slice(0, 200))}`)
    return { ...match.groups, platform: match.groups.platform ?? 'ruby' }
  }
  const found = lines.slice(lines.indexOf('---') + 1).map(parse).filter((entry) => entry.version === version && entry.platform === platform)
  assert.ok(found.length > 0, `${method}: the index has no ${what}`)
  assert.ok(found.length === 1, `${method}: the index has ${what} on ${found.length} lines`)
  const checksums = found[0].metadata.split(',').filter((pair) => pair.startsWith('checksum:'))
  assert.ok(checksums.length === 1, `${method}: the index has ${checksums.length} checksums for ${what}`)
  const checksum = checksums[0].slice('checksum:'.length)
  assertSha256(method, 'the index checksum', checksum)
  return checksum
}

// Gem.user_dir: each <engine>/<ruby version> under ~/.gem and under the XDG
// data dir.
async function userDirs() {
  const base = home()
  if (base === undefined) return []
  const data = absolute(process.env.XDG_DATA_HOME) ?? join(base, '.local', 'share')
  const below = async (dir) => (await readdir(dir).catch(() => [])).map((name) => join(dir, name))
  const engines = (await Promise.all([join(base, '.gem'), join(data, 'gem')].map(below))).flat()
  return (await Promise.all(engines.map(below))).flat()
}

// RubyGems' own downloads, in the cache/ of each gem dir. Gem.default_dir
// depends on how Ruby was built, so is read only as GEM_PATH or GEM_HOME
// names it.
async function localPaths(file) {
  const { GEM_HOME, GEM_PATH } = process.env
  const named = [...(GEM_PATH ?? '').split(delimiter), GEM_HOME ?? ''].filter(Boolean).map((dir) => resolve(dir))
  return [...new Set([...named, ...await userDirs()])].map((dir) => join(dir, 'cache', file))
}

export async function verifyChecksum(name, version, platform, checksum) {
  const { what } = gemOf('verifyChecksum', name, version, platform)
  assertChecksum('verifyChecksum', 'checksum', checksum)
  const indexed = await getChecksum('verifyChecksum', name, version, platform, what)
  assert.ok(indexed === hexOf(checksum), `verifyChecksum: ${what} is ${indexed} on rubygems.org, not ${hexOf(checksum)}`)
}

export async function getGem(name, version, platform, checksum) {
  const { what, file } = gemOf('getGem', name, version, platform)
  if (checksum !== undefined) assertChecksum('getGem', 'checksum', checksum)
  const expected = checksum === undefined ? await getChecksum('getGem', name, version, platform, what) : hexOf(checksum)
  const locate = () => buildUrl(RUBYGEMS, ['gems', encodeSegment(file)])
  return await verifiedDownload({ method: 'getGem', dir: DIR, what, ext: 'gem', algorithm: 'sha256', expected, local: await localPaths(file), locate })
}

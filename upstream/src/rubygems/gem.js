import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { assertGem, assertSha256, assertion, matches, printable } from '../args.js'
import { verifiedDownload } from '../download.js'
import { RUBYGEMS, RUBYGEMS_INDEX, buildUrl, encodeSegment, request } from '../http.js'
import { isGemPlatform } from './platform.js'

// No expiry: rubygems.org takes a version of a platform once. A yank takes
// its file down and its line out of the index, but keeps the version, so
// it is never pushed again, and an unyank puts back the same file.
const DIR = 'rubygems/gems'

const assertPlatform = assertion('`ruby` or a platform as RubyGems writes one', (value) => value === 'ruby' || isGemPlatform(value))
// As Gemfile.lock's CHECKSUMS writes one, or the hex alone.
const assertChecksum = assertion('a sha256 in lowercase hex, bare or after `sha256=`', matches(/^(?:sha256=)?[\da-f]{64}$/u))
const hexOf = (checksum) => checksum.replace(/^sha256=/u, '')

// The arguments, checked, and what they name: `what`, the cache's entry
// too, `<name>@<version>`, then `-<platform>` but for `ruby`, which no other
// three name, as a name has no `@` and a version no `-`; and `file`,
// RubyGems' name for the gem's file.
function gemOf(method, name, version, platform) {
  assertGem(method, name, version)
  assertPlatform(method, 'platform', platform)
  const suffix = platform === 'ruby' ? '' : `-${platform}`
  return { what: `${name}@${version}${suffix}`, file: `${name}-${version}${suffix}.gem` }
}

// A line of the compact index: the version, and the platform after the
// first `-` where not `ruby`, as Bundler splits them; a space and the
// dependencies; and after `|`, comma-separated `key:value` pairs, one of
// them `checksum`, the .gem's sha256.
const LINE = /^(?<version>[^\s|-]+)(?:-(?<platform>[^\s|]+))? [^|]*\|(?<metadata>.*)$/u

// The compact index, what Bundler reads: a file per gem, by its name as
// written (`Rack` is a gem apart from `rack`), with a line per version and
// platform after a `---` line.
async function getChecksum(method, name, version, platform, what) {
  const lines = (await request(buildUrl(RUBYGEMS_INDEX, ['info', name]), { as: 'text' })).split('\n')
  // Ruby's String#split drops the empty lines at the end; Bundler reads
  // all after the first `---`, or every line where there is none.
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

// os.homedir() takes $HOME as it is, and throws where there is none.
function home() {
  try {
    const dir = homedir()
    return isAbsolute(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

// Gem.user_dir: each <engine>/<ruby version> under ~/.gem, and under
// $XDG_DATA_HOME/gem, else ~/.local/share/gem, which RubyGems takes where
// there is no ~/.gem. A relative $XDG_DATA_HOME, which the XDG spec has
// ignored, is not taken.
async function userDirs() {
  const base = home()
  if (base === undefined) return []
  const { XDG_DATA_HOME } = process.env
  const data = typeof XDG_DATA_HOME === 'string' && isAbsolute(XDG_DATA_HOME) ? XDG_DATA_HOME : join(base, '.local', 'share')
  const below = async (dir) => (await readdir(dir).catch(() => [])).map((name) => join(dir, name))
  const engines = (await Promise.all([join(base, '.gem'), join(data, 'gem')].map(below))).flat()
  return (await Promise.all(engines.map(below))).flat()
}

// RubyGems' own downloads, a gem's file in the cache/ of a gem directory:
// those of GEM_PATH, split as RubyGems splits it, and GEM_HOME, where `gem
// install` and Bundler put what they fetch, and Gem.user_dir, where `gem
// install --user-install` does. Gem.default_dir is under the prefix Ruby
// was built with, which only Ruby knows, so is read only as GEM_PATH or
// GEM_HOME names it.
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

// rubygems.org answers for the file itself, from its bucket behind Fastly:
// a redirect is not followed.
export async function getGem(name, version, platform, checksum) {
  const { what, file } = gemOf('getGem', name, version, platform)
  if (checksum !== undefined) assertChecksum('getGem', 'checksum', checksum)
  const expected = checksum === undefined ? await getChecksum('getGem', name, version, platform, what) : hexOf(checksum)
  const locate = () => buildUrl(RUBYGEMS, ['gems', encodeSegment(file)])
  return await verifiedDownload({ method: 'getGem', dir: DIR, what, ext: 'gem', algorithm: 'sha256', expected, local: await localPaths(file), locate })
}

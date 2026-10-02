// The gems of each source, by full name, as RubyGems names a gem's file:
// `name-version`, or `name-version-platform`. Bundler writes each source's
// sorted by it, and each gem's dependencies by name, its runtime ones alone.

import { LockfileError, at, quote } from '../error.js'
import { fail } from '../lines.js'
import { isGemName, isPlatform } from '../rubygems/gem.js'
import { compareVersions, isVersion, parseRequirement } from '../rubygems/version.js'
import { splitLockName } from './syntax.js'

function checkGemName(name, where) {
  if (!isGemName(name)) throw new LockfileError(`${quote(name)} is not a gem name`, where)
  return name
}

// Of a gem as written, of no platform where none is written.
const fullName = ({ name, version, platform = 'ruby' }) => (platform === 'ruby' ? `${name}-${version}` : `${name}-${version}-${platform}`)

// A gem's name, version and platform as written, each held to RubyGems'
// form: `ruby`, the platform of a gem of none, Bundler leaves out.
function readLockName({ name, version, platform }, where) {
  checkGemName(name, where)
  if (!isVersion(version)) throw new LockfileError(`${quote(version)} is not a version as RubyGems writes one`, where)
  if (platform === 'ruby') throw new LockfileError('the platform ruby, which Bundler leaves out of a gem of no platform', where)
  if (platform !== undefined && !isPlatform(platform)) throw new LockfileError(`${quote(platform)} is not a platform as RubyGems writes one`, where)
  return { name, version, platform: platform ?? 'ruby' }
}

// Each `op version`, in the order Bundler writes them, which is backwards;
// none for any version, which `>= 0` alone is. One may be written twice:
// Gem::Requirement drops a requirement given twice as the same text alone,
// and keeps both of `">= 1", ">=1"`.
function readRequirements(list, where) {
  for (const [index, text] of list.entries()) {
    if (parseRequirement(text) === undefined) throw new LockfileError(`${quote(text)} is not a requirement as Bundler writes one, "op version"`, where)
    if (index > 0 && text > list[index - 1]) throw new LockfileError(`${quote(text)} after ${quote(list[index - 1])}, where Bundler sorts them backwards`, where)
  }
  const [only] = list
  if (list.length === 1 && only.startsWith('>= ') && compareVersions(only.slice(3), '0') === 0) throw new LockfileError(`${quote(only)}, which Bundler leaves out, as any version`, where)
  return list
}

// Dependencies by name, sorted, each name once, as Bundler writes a gem's
// and the Gemfile's, `what`: what `read` makes of each one's requirements.
export function readNamed(list, where, what, read = (requirements) => requirements) {
  const named = Object.create(null)
  let prior
  for (const item of list) {
    const here = at(where, item.name)
    checkGemName(item.name, here)
    if (prior !== undefined && item.name <= prior) throw new LockfileError(`${item.name === prior ? 'listed twice' : `after ${quote(prior)}`}, where Bundler sorts ${what} by name`, here)
    prior = item.name
    named[item.name] = read(readRequirements(item.requirements, here), item)
  }
  return named
}

// Every source's specs, by full name, each with the index of its source;
// none of `local`, the Gemfile's own GEM source where it has no remote.
export function readSpecs(raw, local) {
  const specs = Object.create(null)
  for (const [index, { specs: list }] of raw.entries()) {
    let prior
    for (const item of list) {
      const key = fullName(item)
      const where = at('specs', key)
      const { name, version, platform } = readLockName(item, where)
      if (name === 'bundler') throw new LockfileError('Bundler itself, which Bundler leaves out of the sources', where)
      if (key in specs) throw new LockfileError(`listed twice, of which Bundler keeps the last alone, at line ${item.number + 1}`, where)
      if (prior !== undefined && key < prior) throw new LockfileError(`after ${quote(prior)}, where Bundler sorts a source's gems by full name`, where)
      prior = key
      if (index === local) throw new LockfileError(`from sources[${index}], which has no remote: Bundler takes it from the gems installed where it runs`, where)
      specs[key] = { name, version, platform, source: index, dependencies: readNamed(item.dependencies, at(where, 'dependencies'), 'a gem\'s dependencies'), checksum: undefined }
    }
  }
  return specs
}

const CHECKSUM = /^sha256=[\da-f]{64}$/u

function readChecksum(value, where) {
  if (!CHECKSUM.test(value)) throw new LockfileError(`${quote(value)} is not a checksum as Bundler writes one, "sha256=" and the hex digest`, where)
  return value
}

// CHECKSUMS: a line for every spec, sorted, with the sha256 of its .gem
// where Bundler knows it, which a git or path source's gem has none of; and
// in Bundler 4, one of Bundler's own gem.
export function readChecksums(lines, specs, sources) {
  let bundler
  let prior
  const listed = new Set()
  for (const { text: line, number } of lines) {
    if (prior !== undefined && line <= prior) throw fail(`${quote(line)} after ${quote(prior)}, where Bundler sorts the checksums, each once`, number)
    prior = line
    const item = splitLockName(line, number, true)
    if (item.name === 'bundler' && item.platform === undefined && bundler === undefined) {
      const { version } = readLockName(item, 'bundlerChecksum')
      if (item.checksum === undefined) throw fail('Bundler itself, without the checksum Bundler writes it with', number)
      bundler = { version, checksum: readChecksum(item.checksum, at('bundlerChecksum', 'checksum')) }
      continue
    }
    const key = fullName(item)
    const named = quote(line.split(' ', 2).join(' '))
    if (!(key in specs)) throw fail(`${named} is no gem of the sources`, number)
    if (listed.has(key)) throw fail(`${named} a second time, where Bundler lists each gem once`, number)
    listed.add(key)
    const spec = specs[key]
    if (item.checksum === undefined) continue
    const here = at(at('specs', key), 'checksum')
    if (sources[spec.source].type !== 'gem') throw new LockfileError(`a checksum of a gem from a ${sources[spec.source].type} source, which has no .gem to check`, here)
    spec.checksum = readChecksum(item.checksum, here)
  }
  const missing = Object.keys(specs).find((key) => !listed.has(key))
  if (missing !== undefined) throw new LockfileError('not in CHECKSUMS, where Bundler lists every gem', at('specs', missing))
  return bundler
}

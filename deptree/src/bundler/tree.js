// The gems `bundle install` installs into its path from a Gemfile.lock.

import { parseGemfileLock } from '@preventive/lockfile/bundler.js'
import { getGem } from '@preventive/upstream/rubygems.js'
import { Vfs } from '@preventive/vfs'
import { eachConcurrently } from '../concurrent.js'
import { DeptreeError, quote } from '../error.js'
import { bytesSha256Hex } from '../hash.js'
import { fold, mount, writeFiles } from '../mount.js'
import { installGem } from './extract.js'
import { readGem } from './gem.js'
import { checkHost, inputsOf, partialOf } from './inputs.js'
import { about, checkPlatforms, installedSpecs } from './select.js'
import { DEFAULT, sameRequirements, satisfiedBy } from './version.js'

const RUBYGEMS_ORG = 'https://rubygems.org/'

// A refusal `partial` skips the gem for.
class SkipRefusal extends DeptreeError {}

// A Vfs holding the install path already is refused: Bundler takes what is
// in it as installed, and installs beside it.
function checkNoPath(vfs, path, folded) {
  let at = ''
  for (const segment of path.split('/')) {
    const there = vfs.isDirectory(at || '/') ? vfs.readdir(at || '/').find((name) => name === segment || (folded && fold(name) === fold(segment))) : undefined
    if (there === undefined) return
    at = `${at}/${there}`
  }
  throw new DeptreeError(`${quote(path)} is there already, which Bundler takes what is in as installed`, `vfs[${quote(at)}]`)
}

// Bundler 2.3 and later install the Bundler BUNDLED WITH names into the
// path, and switch to it.
function checkBundledWith(lock, host) {
  if (lock.bundledWith === undefined || lock.bundledWith === host.bundler) return
  throw new DeptreeError(`the lockfile is BUNDLED WITH ${lock.bundledWith}, which Bundler ${host.bundler} installs into the path and switches to`, 'host.bundler')
}

const requirementsOf = (texts) => (texts.length === 0 ? DEFAULT : texts.map((text) => text.split(' ')))
const shownRequirements = (pairs) => pairs.map((pair) => pair.join(' ')).join(', ')

// Its .gem's spec held to the lockfile, as Bundler 4 resolves anew where
// they differ, and to the machine's Ruby and RubyGems.
function checkSpec(spec, locked, host, where) {
  for (const field of ['name', 'version', 'platform']) {
    if (spec[field] !== locked[field]) throw new DeptreeError(`its .gem is of the ${field} ${quote(spec[field])}, not ${quote(locked[field])}`, where)
  }
  const deps = new Map()
  for (const dep of spec.dependencies) {
    if (deps.has(dep.name)) throw new DeptreeError(`its .gem has the dependency ${quote(dep.name)} twice, which the lockfile has once`, where)
    deps.set(dep.name, dep.requirements)
  }
  for (const name of new Set([...deps.keys(), ...Object.keys(locked.dependencies)])) {
    const lockedOf = Object.hasOwn(locked.dependencies, name) ? requirementsOf(locked.dependencies[name]) : undefined
    if (lockedOf !== undefined && deps.has(name) && sameRequirements(deps.get(name), lockedOf)) continue
    const shown = (pairs) => (pairs === undefined ? 'nothing' : quote(shownRequirements(pairs)))
    throw new DeptreeError(`its .gem depends on ${quote(name)} by ${shown(deps.get(name))}, the lockfile by ${shown(lockedOf)}, for which Bundler resolves anew`, where)
  }
  for (const [what, version, required] of [['Ruby', host.ruby, spec.requiredRuby], ['RubyGems', host.rubygems, spec.requiredRubygems]]) {
    if (!satisfiedBy(version, required)) throw new DeptreeError(`it requires ${what} ${shownRequirements(required)}, which ${what} ${version} does not meet, for which Bundler takes another gem or resolves anew`, where)
  }
  if (spec.extensions.length > 0) throw new SkipRefusal(`a gem with extensions to build, ${spec.extensions.map(quote).join(', ')}, whose directory holds what they make, is not supported`, where)
}

async function installAll(gems, host, skipped) {
  const contents = new Map()
  const folded = host.os === 'darwin'
  await eachConcurrently(gems, async ({ key, spec: locked }) => {
    const where = about(key)
    const bytes = await getGem(locked.name, locked.version, locked.platform, locked.checksum)
    const checksum = await bytesSha256Hex(bytes)
    if (locked.checksum !== undefined && `sha256=${checksum}` !== locked.checksum) throw new DeptreeError(`its .gem's sha256 is not the lockfile's ${locked.checksum}`, where)
    const { spec, entries } = await readGem(bytes, where)
    try {
      checkSpec(spec, locked, host, where)
    } catch (error) {
      if (skipped === undefined || !(error instanceof SkipRefusal)) throw error
      skipped.set(key, error.message)
      return
    }
    contents.set(key, { bytes, checksum, spec, dir: installGem(entries, spec, folded, where) })
  }, ({ key }) => about(key))
  return contents
}

// Of each gem installed, its .gem in cache/ and its directory in gems/;
// each directory's mode set once what is in it is written.
function writeTree(gems, contents, scope, stats) {
  const vfs = new Vfs()
  for (const { key } of gems) {
    const gem = contents.get(key)
    if (gem === undefined) continue
    writeFiles(vfs, `${scope}/cache`, { dirs: [], files: new Map([[`${key}.gem`, { data: gem.bytes, mode: 0o644 }]]) }, stats)
    const root = `${scope}/gems/${key}`
    writeFiles(vfs, root, { dirs: gem.dir.dirs.map(({ path }) => path), files: gem.dir.files, links: gem.dir.links }, stats)
    for (const { path, mode } of gem.dir.dirs) vfs.chmod(`/${root}/${path}`, mode)
    contents.delete(key)
  }
  return vfs
}

export async function buildBundlerTree(options) {
  const all = options ?? {}
  const { vfs: into } = all
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(all)
  const partial = partialOf(all)
  const host = checkHost(all.host)
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoPath(into, inputs.path, folded)
  const lock = parseGemfileLock(inputs.lockfile)
  checkBundledWith(lock, host)
  checkPlatforms(lock, host.machine, host.platform)
  const skipped = partial ? new Map() : undefined
  const gems = []
  for (const key of installedSpecs(lock, host.machine, host.platform)) {
    const spec = lock.specs[key]
    const source = lock.sources[spec.source]
    if (source.type === 'path') continue
    if (source.type === 'git') {
      const detail = `a gem from git, ${quote(source.remote)}, which Bundler checks out with git, is not supported`
      if (skipped === undefined) throw new DeptreeError(detail, about(key))
      skipped.set(key, `${about(key)}: ${detail}`)
      continue
    }
    if (source.remote !== RUBYGEMS_ORG) throw new DeptreeError(`a gem from ${quote(String(source.remote))} is not supported: only those from ${RUBYGEMS_ORG} are`, about(key))
    gems.push({ key, spec, source })
  }
  const contents = await installAll(gems, host, skipped)
  const scope = `${inputs.path}/${host.scope}`
  const stats = { specs: Object.keys(lock.specs).length, installed: contents.size, files: 0, bytes: 0, links: 0 }
  // In the lockfile's order, before writeTree lets each gem go.
  const installed = gems.filter(({ key }) => contents.has(key)).map(({ key, spec, source }) => {
    const { checksum, spec: own } = contents.get(key)
    return { path: `${scope}/gems/${key}`, name: spec.name, version: spec.version, platform: spec.platform, source: source.remote, checksum, homepage: own.homepage, sourceCodeUri: own.sourceCodeUri }
  })
  const left = Object.keys(lock.specs).filter((key) => skipped?.has(key)).map((key) => {
    const { name, version, platform, source } = lock.specs[key]
    const git = lock.sources[source].type === 'git'
    return { name, version, platform, reason: skipped.get(key), paths: git ? [`${scope}/bundler/gems`, `${scope}/cache/bundler/git`] : [`${scope}/gems/${key}`, `${scope}/cache/${key}.gem`] }
  })
  const vfs = writeTree(gems, contents, scope, stats)
  return { vfs: mount(vfs, into, folded, (target) => checkNoPath(target, inputs.path, folded)), stats, installed, skipped: left }
}

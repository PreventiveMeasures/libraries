// Gemfile.lock, or gems.locked, as Bundler 2.2 to 4.0 write it: each
// source and the gems it locks, the platforms, what the Gemfile asks for,
// the checksums, and the Ruby and Bundler it was locked with. Every
// dependency is held to the gems locked under its name.

import { LockfileError, at, quote } from '../error.js'
import { fail } from '../lines.js'
import { isPlatform, platformServed, platformSet } from '../rubygems/gem.js'
import { isVersion, parseRequirement, satisfiedByAll, satisfies, versionSet } from '../rubygems/version.js'
import { checkOrder, readSource } from './sources.js'
import { readChecksums, readNamed, readSpecs } from './specs.js'
import { readSections, splitDependency } from './syntax.js'

function required(sections, name) {
  const section = sections.get(name)
  if (section === undefined) throw new LockfileError(`no ${name}, which Bundler always writes`)
  return section
}

// Sorted, each once; `ruby` for gems of no platform.
function readPlatforms(section) {
  const platforms = section.lines.map(({ text }) => text)
  if (platforms.length === 0) throw fail('no platform under PLATFORMS', section.number)
  for (const [index, platform] of platforms.entries()) {
    const where = `platforms[${index}]`
    if (platform !== 'ruby' && !isPlatform(platform)) throw new LockfileError(`${quote(platform)} is not a platform as RubyGems writes one`, where)
    if (index > 0 && platform <= platforms[index - 1]) throw new LockfileError(`${quote(platform)} after ${quote(platforms[index - 1])}, where Bundler sorts the platforms, each once`, where)
  }
  return platforms
}

// Every gem of a platform is one Bundler locked for one of PLATFORMS.
function checkPlatforms(specs, platforms) {
  const set = platformSet(platforms)
  for (const [key, { platform }] of Object.entries(specs)) {
    if (platform !== 'ruby' && !platformServed(set, platform)) throw new LockfileError(`of the platform ${quote(platform)}, which no platform of PLATFORMS takes, where Bundler locks a gem for one`, at('specs', key))
  }
}

// What the Gemfile asks for, by name, sorted; `!` where it names the
// source, which is then the source of the gems of that name.
function readDependencies(section) {
  const list = section.lines.map(({ text, number }) => splitDependency(text, number, true))
  return readNamed(list, 'dependencies', 'the dependencies', (requirements, { pinned }) => ({ requirements, pinned }))
}

// RubyVersion#to_s of the Ruby it was locked with: its version, its
// patchlevel, which Bundler 4 leaves out, and the engine's, if not Ruby.
const RUBY = /^ruby \d+\.\d+\.\d+(?:\.[\dA-Za-z]+)*(?:p(?:-1|0|[1-9]\d*))?(?: \((?!ruby )[\w.-]+ [\w.-]+\))?$/u

function readOne(section, name) {
  if (section.lines.length !== 1) throw fail(`expected one line under ${name}, found ${section.lines.length}`, section.number)
  return section.lines[0].text
}

// Either may be left out: Bundler compares a lockfile without them when it
// would write it, and leaves one without them so where nothing else changes.
function readVersions(sections) {
  const read = (name) => (sections.has(name) ? readOne(sections.get(name), name) : undefined)
  const [ruby, bundled] = [read('RUBY VERSION'), read('BUNDLED WITH')]
  if (ruby !== undefined && !RUBY.test(ruby)) throw new LockfileError(`${quote(ruby)} is not a Ruby as Bundler writes one, "ruby 3.3.6p108"`, 'rubyVersion')
  if (bundled !== undefined && !isVersion(bundled)) throw new LockfileError(`${quote(bundled)} is not a version as RubyGems writes one`, 'bundledWith')
  return { rubyVersion: ruby, bundledWith: bundled }
}

// The keys of the specs of each name, which Bundler takes from one source,
// at one version for each platform.
function readGems(specs) {
  const gems = Object.create(null)
  for (const [key, spec] of Object.entries(specs)) {
    const prior = gems[spec.name]?.[0]
    if (prior !== undefined && specs[prior].source !== spec.source) throw new LockfileError(`from sources[${spec.source}], and ${quote(prior)} from sources[${specs[prior].source}], where Bundler takes a gem from one source`, at('specs', key))
    const twin = gems[spec.name]?.find((other) => specs[other].platform === spec.platform)
    if (twin !== undefined) throw new LockfileError(`for the platform of ${quote(twin)}, where Bundler locks one version of a gem for each`, at('specs', key))
    ;(gems[spec.name] ??= []).push(key)
  }
  return gems
}

// What the Gemfile names no source of, without its `!`, Bundler takes from
// its default source, one: the GEM one of the Gemfile's own, which is the
// one of no remote where there is one, or, in Bundler 2, the directory of
// a lone `path`. A git source is never the default.
function checkDefaultSource({ specs, gems, dependencies, sources }) {
  const local = sources.findIndex((source) => source.type === 'gem' && source.remote === undefined)
  let first
  for (const [name, { pinned }] of Object.entries(dependencies)) {
    if (pinned || gems[name] === undefined) continue
    const where = at('dependencies', name)
    const index = specs[gems[name][0]].source
    const { type } = sources[index]
    if (type === 'git') throw new LockfileError('from a git source, without the "!" Bundler writes of it', where)
    if (type === 'gem' && local !== -1) throw new LockfileError(`from sources[${index}], where Bundler takes what the Gemfile names no source of from its default, sources[${local}], of no remote`, where)
    first ??= { name, index }
    if (index !== first.index) throw new LockfileError(`from sources[${index}], and ${quote(first.name)} from sources[${first.index}], where Bundler takes what the Gemfile names no source of from its default alone`, where)
  }
}

// A requirement on a name is met by every gem locked under it, as Bundler
// may install any of them, by its platform: checked against them as a set,
// then, of one unmet, gem by gem for the first that does not meet it.
function checkMet(name, requirements, { specs, gems, versions }, where) {
  const set = versions.get(name)
  if (set === undefined || requirements.every((text) => satisfiedByAll(set, parseRequirement(text)))) return
  for (const key of gems[name]) {
    const unmet = requirements.find((text) => !satisfies(specs[key].version, parseRequirement(text)))
    if (unmet !== undefined) throw new LockfileError(`${quote(unmet)} is not met by ${quote(key)}`, where)
  }
}

// Every edge leads to gems locked under its name, or, of the Gemfile, to
// none where Bundler leaves out a platform's gem; every gem is reached.
function checkGraph(lock) {
  const { specs, gems, dependencies } = lock
  const reached = new Set()
  const queue = []
  const visit = (name) => {
    if (name in gems && !reached.has(name)) queue.push(name)
    reached.add(name)
  }
  for (const [name, { requirements }] of Object.entries(dependencies)) {
    checkMet(name, requirements, lock, at('dependencies', name))
    visit(name)
  }
  while (queue.length > 0) {
    for (const key of gems[queue.pop()]) {
      for (const [name, requirements] of Object.entries(specs[key].dependencies)) {
        const where = at(at(at('specs', key), 'dependencies'), name)
        // Bundler, which the sources leave out, it meets with whichever
        // Bundler runs.
        if (name !== 'bundler' && !(name in gems)) throw new LockfileError('names no gem of the sources', where)
        checkMet(name, requirements, lock, where)
        visit(name)
      }
    }
  }
  const stray = Object.keys(gems).find((name) => !reached.has(name))
  if (stray !== undefined) throw new LockfileError('nothing depends on it, and Bundler locks what it resolves alone', at('specs', gems[stray][0]))
}

export function parseGemfileLock(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const { sources: raw, sections } = readSections(text)
  const sources = raw.map((source, index) => readSource(source, `sources[${index}]`))
  checkOrder(sources, raw)
  const specs = readSpecs(raw, sources)
  const platforms = readPlatforms(required(sections, 'PLATFORMS'))
  checkPlatforms(specs, platforms)
  const dependencies = readDependencies(required(sections, 'DEPENDENCIES'))
  const gems = readGems(specs)
  const versions = new Map(Object.entries(gems).map(([name, keys]) => [name, versionSet(keys.map((key) => specs[key].version))]))
  checkDefaultSource({ specs, gems, dependencies, sources })
  checkGraph({ specs, gems, versions, dependencies })
  const checksums = sections.has('CHECKSUMS')
  const bundlerChecksum = checksums ? readChecksums(sections.get('CHECKSUMS').lines, specs, sources) : undefined
  return { sources, specs, gems, platforms, dependencies, checksums, bundlerChecksum, ...readVersions(sections) }
}

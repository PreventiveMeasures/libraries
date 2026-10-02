// Gemfile.lock, or gems.locked, as Bundler 2.2 to 4.0 write it: each
// source and the gems it locks, the platforms, what the Gemfile asks for,
// the checksums, and the Ruby and Bundler it was locked with. Every
// dependency is held to the gems locked under its name.

import { LockfileError, at, quote } from '../error.js'
import { fail } from '../lines.js'
import { isPlatform } from '../rubygems/gem.js'
import { isVersion, parseRequirement, satisfies } from '../rubygems/version.js'
import { readSource } from './sources.js'
import { checkGemName, readChecksums, readRequirements, readSpecs } from './specs.js'
import { indentOf, readSections, splitDependency } from './syntax.js'

// Each line two spaces in; RUBY VERSION's and BUNDLED WITH's, three in
// from Bundler 2, which Bundler 4 writes two in.
function lineTexts(section, indents = [2]) {
  return section.lines.map(({ text, number }) => {
    if (!indents.includes(indentOf(text))) throw fail(`expected ${indents.join(' or ')} spaces of indentation, found ${indentOf(text)}`, number)
    return { text: text.slice(indentOf(text)), indent: indentOf(text), number }
  })
}

function required(sections, name) {
  const section = sections.get(name)
  if (section === undefined) throw new LockfileError(`no ${name}, which Bundler always writes`)
  return section
}

// Sorted, each once; `ruby` for gems of no platform.
function readPlatforms(section) {
  const platforms = lineTexts(section).map(({ text }) => text)
  if (platforms.length === 0) throw fail('no platform under PLATFORMS', section.number)
  for (const [index, platform] of platforms.entries()) {
    const where = `platforms[${index}]`
    if (platform !== 'ruby' && !isPlatform(platform)) throw new LockfileError(`${quote(platform)} is not a platform as RubyGems writes one`, where)
    if (index > 0 && platform <= platforms[index - 1]) throw new LockfileError(`${quote(platform)} after ${quote(platforms[index - 1])}, where Bundler sorts the platforms, each once`, where)
  }
  return platforms
}

// What the Gemfile asks for, by name, sorted; `!` where it names the
// source, which is then the source of the gems of that name.
function readDependencies(section) {
  const dependencies = Object.create(null)
  let prior
  for (const { text, number } of lineTexts(section)) {
    const { name, requirements, pinned } = splitDependency(text, number, true)
    const where = at('dependencies', name)
    checkGemName(name, where)
    if (prior !== undefined && name <= prior) throw new LockfileError(`${name === prior ? 'listed twice' : `after ${quote(prior)}`}, where Bundler sorts the dependencies by name`, where)
    prior = name
    dependencies[name] = { requirements: readRequirements(requirements, where), pinned }
  }
  return dependencies
}

// RubyVersion#to_s of the Ruby it was locked with: its version, its
// patchlevel, which Bundler 4 leaves out, and the engine's, if not Ruby.
const RUBY = /^ruby \d+\.\d+\.\d+(?:\.[\dA-Za-z]+)*(?:p(?:-1|0|[1-9]\d*))?(?: \((?!ruby )[\w.-]+ [\w.-]+\))?$/u

function readOne(section, name) {
  const lines = lineTexts(section, [2, 3])
  if (lines.length !== 1) throw fail(`expected one line under ${name}, found ${lines.length}`, section.number)
  return lines[0]
}

// Either may be left out: Bundler compares a lockfile without them when it
// would write it, and leaves one without them so where nothing else changes.
function readVersions(sections) {
  const read = (name) => (sections.has(name) ? readOne(sections.get(name), name) : undefined)
  const [ruby, bundled] = [read('RUBY VERSION'), read('BUNDLED WITH')]
  if (ruby !== undefined && !RUBY.test(ruby.text)) throw new LockfileError(`${quote(ruby.text)} is not a Ruby as Bundler writes one, "ruby 3.3.6p108"`, 'rubyVersion')
  if (bundled !== undefined && !isVersion(bundled.text)) throw new LockfileError(`${quote(bundled.text)} is not a version as RubyGems writes one`, 'bundledWith')
  if (ruby !== undefined && bundled !== undefined && ruby.indent !== bundled.indent) throw fail(`${ruby.indent} spaces of indentation, and ${bundled.indent} under BUNDLED WITH`, ruby.number)
  return { rubyVersion: ruby?.text, bundledWith: bundled?.text }
}

// The keys of the specs of each name, which Bundler takes from one source.
function readGems(specs) {
  const gems = Object.create(null)
  for (const [key, spec] of Object.entries(specs)) {
    const prior = gems[spec.name]?.[0]
    if (prior !== undefined && specs[prior].source !== spec.source) throw new LockfileError(`from sources[${spec.source}], and ${quote(prior)} from sources[${specs[prior].source}], where Bundler takes a gem from one source`, at('specs', key))
    ;(gems[spec.name] ??= []).push(key)
  }
  return gems
}

// A requirement on a name is met by every gem locked under it, as Bundler
// may install any of them, by its platform. Bundler, which the sources
// leave out, it meets with whichever Bundler runs.
function checkMet(name, requirements, { specs, gems }, where) {
  if (name === 'bundler') return
  for (const key of gems[name] ?? []) {
    const unmet = requirements.find((text) => !satisfies(specs[key].version, parseRequirement(text)))
    if (unmet !== undefined) throw new LockfileError(`${quote(unmet)} is not met by ${quote(key)}`, where)
  }
}

// Every edge leads to gems locked under its name, or, of the Gemfile, to
// none where Bundler leaves out a platform's gem; every gem is reached.
function checkGraph(lock) {
  const { specs, gems, dependencies, sources } = lock
  const reached = new Set()
  const queue = []
  const visit = (name) => {
    if (name in gems && !reached.has(name)) queue.push(name)
    reached.add(name)
  }
  for (const [name, { requirements, pinned }] of Object.entries(dependencies)) {
    const where = at('dependencies', name)
    checkMet(name, requirements, lock, where)
    const source = gems[name] === undefined ? undefined : sources[specs[gems[name][0]].source]
    if (!pinned && source !== undefined && source.type !== 'gem') throw new LockfileError(`from a ${source.type} source, without the "!" Bundler writes of it`, where)
    visit(name)
  }
  while (queue.length > 0) {
    for (const key of gems[queue.pop()]) {
      for (const [name, requirements] of Object.entries(specs[key].dependencies)) {
        const where = at(at(at('specs', key), 'dependencies'), name)
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
  const specs = readSpecs(raw, sources)
  const platforms = readPlatforms(required(sections, 'PLATFORMS'))
  const dependencies = readDependencies(required(sections, 'DEPENDENCIES'))
  const gems = readGems(specs)
  checkGraph({ specs, gems, dependencies, sources })
  const checksums = sections.has('CHECKSUMS')
  const bundlerChecksum = checksums ? readChecksums(sections.get('CHECKSUMS').lines, specs, sources) : undefined
  return { sources, specs, gems, platforms, dependencies, checksums, bundlerChecksum, ...readVersions(sections) }
}

// Gemfile.lock laid out exactly as Bundler's LockfileGenerator writes it.
// Bundler's own LockfileParser takes much more: it skips a line it does not
// read, and a section it does not know, and reads a line of another
// indentation as something else. Each line here is split into its parts,
// which the readers beside this one hold to what they are.

import { LockfileError, quote } from '../error.js'
import { UNWRITTEN, advance, fail, lines } from '../lines.js'

// What Bundler refuses a lockfile for wherever it is, as a merge conflict.
const CONFLICT = /<<<<<<<|=======|>>>>>>>|\|{7}/u

// GEM's after the others, then the sections, in the order Bundler writes
// them, each with the indentations of its lines: RUBY VERSION's and BUNDLED
// WITH's three spaces in from Bundler 2, which Bundler 4 writes two in.
const SOURCES = new Set(['GIT', 'PATH', 'GEM'])
const SECTIONS = { PLATFORMS: [2], DEPENDENCIES: [2], CHECKSUMS: [2], 'RUBY VERSION': [2, 3], 'BUNDLED WITH': [2, 3] }
const ORDER = Object.keys(SECTIONS)

const indentOf = (line) => /^ */u.exec(line)[0].length

function expectIndent(line, expected, number) {
  const indent = indentOf(line)
  if (!expected.includes(indent)) throw fail(`expected ${expected.join(' or ')} spaces of indentation, found ${indent}`, number)
  return line.slice(indent)
}

// `name (version)`, or `name (version-platform)`, split as Bundler splits it,
// at the first `-` within the parentheses.
const LOCK_NAME = /^([^\s()]+) \(([^\s()]+)\)(?: (\S+))?$/u

export function splitLockName(text, number, checksum) {
  const match = LOCK_NAME.exec(text)
  if (match === null || (!checksum && match[3] !== undefined)) throw fail(`expected a gem as "name (version)", found ${quote(text)}`, number)
  const [, name, both, rest] = match
  const sep = both.indexOf('-')
  return { name, version: sep === -1 ? both : both.slice(0, sep), platform: sep === -1 ? undefined : both.slice(sep + 1), checksum: rest, number }
}

// `name`, or `name (requirement, requirement)`, and `!` where pinned.
const DEPENDENCY = /^([^\s()!]+)(?: \(([^()]+)\))?(!)?$/u

export function splitDependency(text, number, pinned) {
  const match = DEPENDENCY.exec(text)
  if (match === null || (!pinned && match[3] !== undefined)) throw fail(`expected a dependency as "name" or "name (requirement)", found ${quote(text)}`, number)
  return { name: match[1], requirements: match[2]?.split(', ') ?? [], pinned: match[3] !== undefined }
}

// `key: value`, two spaces in.
const OPTION = /^ {2}([a-z]+): (.+)$/u

// A source: its options, in order, then `specs:` and each spec, four spaces
// in, with its dependencies, six.
function readSource(src) {
  const { line: type, number } = src
  const options = []
  for (advance(src); ; advance(src)) {
    const option = OPTION.exec(src.line ?? '')
    if (option === null) break
    options.push({ key: option[1], value: option[2], number: src.number })
  }
  if (src.line !== '  specs:') throw fail(`expected an option, "key: value", or "specs:", two spaces in, found ${src.line === undefined ? 'the end of the file' : quote(src.line)}`, src.number)
  const specs = []
  for (advance(src); src.line?.startsWith(' '); advance(src)) {
    const text = expectIndent(src.line, [4, 6], src.number)
    if (src.line.length - text.length === 4) {
      specs.push({ ...splitLockName(text, src.number, false), dependencies: [] })
      continue
    }
    if (specs.length === 0) throw fail('a dependency before any spec', src.number)
    specs.at(-1).dependencies.push(splitDependency(text, src.number, false))
  }
  return { type, number, options, specs }
}

// A section's lines, each at an indentation `indents` takes, and with it,
// and its number.
function readLines(src, indents) {
  const list = []
  for (advance(src); src.line?.startsWith(' '); advance(src)) {
    const text = expectIndent(src.line, indents, src.number)
    list.push({ text, indent: src.line.length - text.length, number: src.number })
  }
  return list
}

// RUBY VERSION and BUNDLED WITH at one indentation, as one Bundler writes both.
function checkVersionsIndent(sections) {
  const [ruby, bundled] = ['RUBY VERSION', 'BUNDLED WITH'].map((name) => sections.get(name)?.lines[0])
  if (ruby !== undefined && bundled !== undefined && ruby.indent !== bundled.indent) throw fail(`${ruby.indent} spaces of indentation, and ${bundled.indent} under BUNDLED WITH`, ruby.number)
}

// The sources, then each section by its name; one blank line between two,
// none elsewhere, and a line end after the last line.
export function readSections(text) {
  const conflict = CONFLICT.exec(text)?.[0]
  if (conflict !== undefined) throw new LockfileError(`${quote(conflict)}, which Bundler reads as a merge conflict`)
  if (text === '') throw new LockfileError('an empty lockfile, which Bundler reads as none')
  if (!text.endsWith('\n')) throw new LockfileError('no line end after the last line, where Bundler ends every line')
  const src = lines(text, UNWRITTEN)
  const sources = []
  const sections = new Map()
  let last
  for (advance(src); src.line !== undefined;) {
    const { line, number } = src
    if (line === '' || line.startsWith(' ')) throw fail(line === '' ? 'a blank line, where Bundler writes one between sections alone' : 'expected a section, at column 0', number)
    if (line === 'PLUGIN SOURCE') throw fail('a plugin source, which only its plugin can read, and which is not read here', number)
    if (SOURCES.has(line)) {
      if (last !== undefined) throw fail(`a ${line} source after ${last}, where Bundler writes the sources first`, number)
      if (line !== 'GEM' && sources.at(-1)?.type === 'GEM') throw fail(`a ${line} source after a GEM one, where Bundler writes the GEM sources last`, number)
      sources.push(readSource(src))
    } else {
      const index = ORDER.indexOf(line)
      if (index === -1) throw fail(`${quote(line)} is not a section Bundler writes`, number)
      if (sections.has(line)) throw fail(`a second ${line}`, number)
      if (index < ORDER.indexOf(last)) throw fail(`${line} after ${last}, where Bundler writes it before`, number)
      last = line
      sections.set(line, { number, lines: readLines(src, SECTIONS[line]) })
    }
    if (src.line === undefined) break
    if (src.line !== '') throw fail(`expected a blank line before ${quote(src.line)}`, src.number)
    advance(src)
    if (src.line === undefined) throw fail('a blank line at the end, where Bundler writes none', src.number)
  }
  checkVersionsIndent(sections)
  return { sources, sections }
}

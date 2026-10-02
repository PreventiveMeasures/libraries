// Gemfile.lock laid out exactly as Bundler's LockfileGenerator writes it.
// Bundler's own LockfileParser takes much more: it skips a line it does not
// read, and a section it does not know, and reads a line of another
// indentation as something else. Each line here is split into its parts,
// which the readers beside this one hold to what they are.

import { LockfileError, quote } from '../error.js'
import { advance, fail, lines } from '../lines.js'

// Never written by Bundler; a lone CR ends a line to some other readers.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF\uFFFE\uFFFF\u2028\u2029]/u

// What Bundler refuses a lockfile for wherever it is, as a merge conflict.
const CONFLICT = /<<<<<<<|=======|>>>>>>>|\|{7}/u

// GEM's after the others, then the sections, in the order Bundler writes them.
const SOURCES = new Set(['GIT', 'PATH', 'GEM'])
const SECTIONS = ['PLATFORMS', 'DEPENDENCIES', 'CHECKSUMS', 'RUBY VERSION', 'BUNDLED WITH']

export const indentOf = (line) => /^ */u.exec(line)[0].length

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
  return { name: match[1], requirements: match[2]?.split(', ') ?? [], pinned: match[3] !== undefined, number }
}

// `key: value`, two spaces in.
const OPTION = /^ {2}([a-z]+): (.+)$/u

// A source: its options, in order, then `specs:` and each spec, four spaces
// in, with its dependencies, six.
function readSource(src) {
  const { line: type, number } = src
  const options = []
  for (advance(src); src.line !== undefined && OPTION.test(src.line); advance(src)) {
    const [, key, value] = OPTION.exec(src.line)
    options.push({ key, value, number: src.number })
  }
  if (src.line !== '  specs:') throw fail(`expected an option, "key: value", or "specs:", two spaces in, found ${src.line === undefined ? 'the end of the file' : quote(src.line)}`, src.number)
  const specs = []
  for (advance(src); src.line?.startsWith(' '); advance(src)) {
    const text = expectIndent(src.line, [4, 6], src.number)
    if (indentOf(src.line) === 4) {
      specs.push({ ...splitLockName(text, src.number, false), dependencies: [] })
      continue
    }
    if (specs.length === 0) throw fail('a dependency before any spec', src.number)
    specs.at(-1).dependencies.push(splitDependency(text, src.number, false))
  }
  return { type, number, options, specs }
}

// A section's lines, each with its number and its indentation as written.
function readLines(src) {
  const list = []
  for (advance(src); src.line?.startsWith(' '); advance(src)) list.push({ text: src.line, number: src.number })
  return list
}

// The sources, then each section by its name; one blank line between two,
// none elsewhere, and a line end after the last line.
export function readSections(text) {
  const conflict = CONFLICT.exec(text)?.[0]
  if (conflict !== undefined) throw new LockfileError(`${quote(conflict)}, which Bundler reads as a merge conflict`)
  if (text === '') throw new LockfileError('an empty lockfile, which Bundler reads as none')
  if (!text.endsWith('\n')) throw new LockfileError('no line end after the last line, where Bundler ends every line')
  const src = lines(text, FORBIDDEN)
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
      const index = SECTIONS.indexOf(line)
      if (index === -1) throw fail(`${quote(line)} is not a section Bundler writes`, number)
      if (sections.has(line)) throw fail(`a second ${line}`, number)
      if (index < SECTIONS.indexOf(last)) throw fail(`${line} after ${last}, where Bundler writes it before`, number)
      last = line
      sections.set(line, { number, lines: readLines(src) })
    }
    if (src.line === undefined) break
    if (src.line !== '') throw fail(`expected a blank line before ${quote(src.line)}`, src.number)
    advance(src)
    if (src.line === undefined) throw fail('a blank line at the end, where Bundler writes none', src.number)
  }
  return { sources, sections }
}

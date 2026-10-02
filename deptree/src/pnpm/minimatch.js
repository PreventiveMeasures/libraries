// minimatch as npm-packlist runs it, with matchBase, dot, flipNegate and
// nocase, of patterns whose only glob syntax is `*`, `?` and `**`: 5.1.6 for
// pnpm 9 and for 10 before 10.31, 5.1.9 for 10 from 10.31, which matches
// `**` by other steps, and 10.2 for pnpm 11. Its regexps have no `u`, as
// minimatch's have none: they take UTF-16 code units, and fold case as such
// a regexp folds it.

import { DeptreeError, quote } from '../error.js'
import { escape } from '../matcher.js'

export const GLOBSTAR = Symbol('**')

// Characters with a meaning to minimatch, glob or globset that is not
// followed here, and those a regexp's `.` does not take.
const UNFOLLOWED = /[()[\\\]{|}\p{Cc}\u2028\u2029]/u

// `body` is a pattern with its leading `!`s taken off. A `.` part, an
// empty one and `**` beside other characters are read by each as written,
// and so is a `..` part where `parent` says, which then reads nothing.
export function checkGlob(body, where, { parent = false } = {}) {
  const odd = UNFOLLOWED.test(body) ? 'glob syntax' : !parent && body.split('/').includes('..') ? 'a .. part' : undefined
  if (odd !== undefined) throw new DeptreeError(`${quote(body)} has ${odd}, which is not followed here: of glob syntax, only * and ? are`, where)
}

// The one way a regexp of minimatch's is made here: with no `u`, as its own.
// oxlint-disable-next-line require-unicode-regexp
export const caseless = (source) => new RegExp(source, 'i')

const NO_TRAVERSAL_5 = String.raw`(?!(?:^|\/)\.{1,2}(?:$|\/))`
const NO_TRAVERSAL_10 = String.raw`(?!(?:^|/)\.\.?(?:$|/))`

const bodyOf = (text, star) => text.replace(/\*+/gu, '*').split(/([*?])/u).map((piece) => (piece === '*' ? star : piece === '?' ? '[^/]' : escape(piece))).join('')

const foldless = (text) => text.toUpperCase() === text.toLowerCase()

export function part5(text) {
  if (text === '**') return GLOBSTAR
  if (!/[*?]/u.test(text)) return text === '' || foldless(text) ? text : caseless(`^${escape(text)}$`)
  return caseless(`^${/^[*?]/u.test(text) ? NO_TRAVERSAL_5 : ''}(?=.)${bodyOf(text, '[^/]*?')}$`)
}

// minimatch 10's own tests of a part, which it runs in place of its regexp.
const FAST = [
  [/^\*+$/u, () => (f) => f.length !== 0 && f !== '.' && f !== '..'],
  [/^\*+([^!(*+?@[]*)$/u, ([, ext]) => (f) => f.toLowerCase().endsWith(ext.toLowerCase())],
  [/^\?+([^!(*+?@[]*)?$/u, ([whole, ext]) => (f) => f.length === whole.length && f !== '.' && f !== '..' && (!ext || f.toLowerCase().endsWith(ext.toLowerCase()))],
  [/^\*+\.\*+$/u, () => (f) => f !== '.' && f !== '..' && f.includes('.')],
  [/^\.\*+$/u, () => (f) => f !== '.' && f !== '..' && f.startsWith('.')],
]

function part10(text) {
  if (text === '**') return GLOBSTAR
  const magic = /[*?]/u.test(text)
  if (!magic) return text === '' || foldless(text) ? text : caseless(`^${escape(text)}$`)
  const fast = FAST.find(([re]) => re.test(text))
  if (fast !== undefined) return { test: fast[1](text.match(fast[0])) }
  const start = /^\.{0,2}[*?]/u.test(text) ? NO_TRAVERSAL_10 : ''
  return caseless(`^${start}${bodyOf(text, /^\*+$/u.test(text) ? '[^/]+?' : '[^/]*?')}$`)
}

const hit = (part, name) => (typeof part === 'string' ? name === part : part.test(name))
const traversal = (name) => name === '.' || name === '..'

// How a match ends where file or pattern runs out at `fi` and `pi`.
function ended(file, pattern, fi, pi, partial) {
  if (fi === file.length) return pi === pattern.length || partial
  return pi === pattern.length && fi === file.length - 1 && file[fi] === ''
}

function matchFlat(file, pattern, partial, fileIndex = 0) {
  let fi = fileIndex
  let pi = 0
  for (; fi < file.length && pi < pattern.length; fi++, pi++) {
    if (pattern[pi] === GLOBSTAR || !hit(pattern[pi], file[fi])) return false
  }
  return ended(file, pattern, fi, pi, partial)
}

// minimatch 5.1.6's matchOne: a `**` swallows each count of parts in turn.
function matchOld(file, pattern, partial) {
  let fi = 0
  let pi = 0
  for (; fi < file.length && pi < pattern.length; fi++, pi++) {
    if (pattern[pi] !== GLOBSTAR) {
      if (!hit(pattern[pi], file[fi])) return false
      continue
    }
    if (pi + 1 === pattern.length) return !file.slice(fi).some(traversal)
    let fr = fi
    for (; fr < file.length; fr++) {
      if (matchOld(file.slice(fr), pattern.slice(pi + 1), partial)) return true
      if (traversal(file[fr])) break
    }
    return partial && fr === file.length
  }
  return ended(file, pattern, fi, pi, partial)
}

// minimatch 5.1.9's and 10's: a head, a tail, and the sections between `**`s.
function matchNew(file, pattern, partial) {
  if (!pattern.includes(GLOBSTAR)) return matchFlat(file, pattern, partial)
  const first = pattern.indexOf(GLOBSTAR)
  const last = pattern.lastIndexOf(GLOBSTAR)
  const head = pattern.slice(0, first)
  const body = partial ? pattern.slice(first + 1) : pattern.slice(first + 1, last)
  const tail = partial ? [] : pattern.slice(last + 1)
  if (head.length && !matchFlat(file.slice(0, head.length), head, partial)) return false
  const fileIndex = head.length
  let tailMatch = 0
  if (tail.length) {
    if (tail.length + fileIndex > file.length) return false
    const tailStart = file.length - tail.length
    if (matchFlat(file, tail, partial, tailStart)) tailMatch = tail.length
    else {
      if (file.at(-1) !== '' || fileIndex + tail.length === file.length) return false
      if (!matchFlat(file, tail, partial, tailStart - 1)) return false
      tailMatch = tail.length + 1
    }
  }
  if (!body.length) {
    const rest = file.slice(fileIndex, file.length - tailMatch)
    return !rest.some(traversal) && (partial || tailMatch > 0 || rest.length > 0)
  }
  const sections = [[]]
  for (const part of body) {
    if (part === GLOBSTAR) sections.push([])
    else sections.at(-1).push(part)
  }
  // Each section's last start, from the parts before the section that
  // mirrors it, as minimatch reckons it.
  const before = sections.map((_, i) => sections.slice(0, i).reduce((sum, section) => sum + section.length, 0))
  const after = sections.map((section, i) => file.length - tailMatch - (before[sections.length - 1 - i] + section.length))
  return Boolean(matchSections(file, sections, after, fileIndex, 0, partial, tailMatch > 0, 0))
}

function matchSections(file, sections, after, fileIndex, index, partial, sawTail, depth) {
  if (index === sections.length) {
    const rest = file.slice(fileIndex)
    return !rest.some(traversal) && (sawTail || rest.length > 0)
  }
  const section = sections[index]
  for (let at = fileIndex; at <= after[index]; at++) {
    if (matchFlat(file.slice(0, at + section.length), section, partial, at) && depth < 200) {
      const sub = matchSections(file, sections, after, at + section.length, index + 1, partial, sawTail, depth + 1)
      if (sub !== false) return sub
    }
    if (traversal(file[at])) return false
  }
  return partial || null
}

// The part minimatch makes of `[object Object]`, the path npm-packlist has
// for a `browser` or `main` that is an object: one character of a class.
export const OBJECT_5 = caseless(`^${NO_TRAVERSAL_5}(?=.)[object Object]$`)
const OBJECT_10 = caseless(`^${NO_TRAVERSAL_10}[object Object]$`)

// minimatch 10's levelOneOptimize: `**`s in a row as one, and a part
// before `..` taken out with it.
function levelOne(parts) {
  const out = []
  for (const part of parts) {
    const prev = out.at(-1)
    if (part === '**' && prev === '**') continue
    if (part === '..' && prev && prev !== '..' && prev !== '.' && prev !== '**') out.pop()
    else out.push(part)
  }
  return out.length === 0 ? [''] : out
}

// A rule as ignore-walk reads one, or as npm-packlist makes one, by the
// minimatch pnpm bundles: `5.1.6`, `5.1.9` or `10.2`.
function compile(pattern, minimatch, where) {
  if (pattern.startsWith('#')) return { negate: false, globParts: [], test: () => false }
  const bangs = pattern.match(/^!*/u)[0].length
  const body = pattern.slice(bangs)
  const five = minimatch !== '10.2'
  if (body.replace(/^\//u, '') === '[object Object]') return fromParts(bangs % 2 === 1, [[...body.startsWith('/') ? [''] : [], five ? OBJECT_5 : OBJECT_10]], minimatch)
  checkGlob(body, where, { parent: true })
  const split = body.split(/\/+/u)
  return fromParts(bangs % 2 === 1, [five ? split : levelOne(split)], minimatch)
}

// The rules of lines as ignore-walk reads them, an ignore file's or those
// npm-packlist hands it: each line trimmed, and none of a blank one or a
// comment. A rule given made is kept as it is.
export function rulesOf(lines, minimatch, where) {
  return lines.flatMap((line) => (typeof line === 'string' ? line.split(/\r?\n/u).map((rule) => rule.trim()).filter((rule) => rule !== '' && !rule.startsWith('#')).map((rule) => compile(rule, minimatch, where)) : [line]))
}

// `globParts` are the patterns' parts, as text but for those given parsed;
// ignore-walk 8 reads them. `test(path, partial)` is whether one matches,
// with matchBase.
export function fromParts(negate, globParts, minimatch) {
  const set = globParts.map((parts) => parts.map((part) => (typeof part === 'string' ? (minimatch === '10.2' ? part10(part) : part5(part)) : part)))
  const matchOne = minimatch === '5.1.6' ? matchOld : matchNew
  const test = (path, partial = false) => {
    if (path === '/' && partial) return true
    const file = path.split(/\/+/u)
    const base = file.findLast(Boolean) ?? file[0]
    return set.some((pattern) => matchOne(pattern.length === 1 ? [base] : file, pattern, partial))
  }
  return { negate, globParts, set, test }
}

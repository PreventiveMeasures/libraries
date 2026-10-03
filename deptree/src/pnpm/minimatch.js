// minimatch as npm-packlist runs it, with matchBase, dot, flipNegate and
// nocase, of patterns whose only glob syntax is `*`, `?` and `**`: 5.1.6 for
// pnpm 9 and for 10 before 10.31, 5.1.9 for 10 from 10.31, which matches
// `**` by other steps, and 10.2 for pnpm 11. Its regexps have no `u`, as
// minimatch's have none: they take UTF-16 code units, and fold case as such
// a regexp folds it.

import { DeptreeError, quote } from '../error.js'

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

// A longer pattern minimatch may make too large a regexp of for V8, which
// pnpm 9, 10 and 11 then fail on, and globset one, which pnpm 12 then drops
// with the rest of its file; none does below several times this.
const MAX_LENGTH = 4096

export function checkLength(pattern, where) {
  if (pattern.length > MAX_LENGTH) throw new DeptreeError(`a pattern of more than ${MAX_LENGTH} characters, which pnpm may make too large a regexp of, is not supported`, where)
}

// More `**` than this are not matched here, which matching each takes time
// for.
const MAX_GLOBSTARS = 100

export function checkParts(pattern, parts, where) {
  if (parts.filter((part) => part === '**').length > MAX_GLOBSTARS) throw new DeptreeError(`${quote(pattern)} has more than ${MAX_GLOBSTARS} ** parts, which is not supported`, where)
}

// Of minimatch's own parts, only those of fixed text are regexps here,
// with no `u`, as its own.
// oxlint-disable-next-line require-unicode-regexp
export const caseless = (source) => new RegExp(source, 'i')

export const NO_TRAVERSAL_5 = String.raw`(?!(?:^|\/)\.{1,2}(?:$|\/))`
const NO_TRAVERSAL_10 = String.raw`(?!(?:^|/)\.\.?(?:$|/))`

// What a regexp with `i` and no `u` takes a code unit for: its upper case
// where that is one code unit, but not one below 128 for one above.
const canonicals = new Map()
function canonical(unit) {
  let found = canonicals.get(unit)
  if (found === undefined) {
    const upper = String.fromCodePoint(unit).toUpperCase()
    found = upper.length === 1 && !(unit >= 128 && upper.codePointAt(0) < 128) ? upper.codePointAt(0) : unit
    canonicals.set(unit, found)
  }
  return found
}

// A text's UTF-16 code unit at `i`, which a regexp with no `u` takes one by
// one.
// oxlint-disable-next-line unicorn/prefer-code-point
const unitAt = (text, i) => text.charCodeAt(i)

const STAR = -1
const ANY = -2
const SLASH = 0x2F
const LINE_TERMINATORS = new Set([0x0A, 0x0D, 0x2028, 0x2029])

// A part as minimatch's regexp of it matches a name, in time linear in
// both: `*` any run of code units but `/`, `?` any one, each other one
// itself without case. `lookahead` is minimatch 5's `(?=.)`, which takes no
// name that is empty or starts with a line terminator; `traversal` its
// lookahead that takes no `.` or `..`.
function partOf(text, { lookahead = false, traversal = false, empty = true } = {}) {
  const units = Array.from({ length: text.length }, (_, i) => {
    const unit = unitAt(text, i)
    return unit === 0x2A ? STAR : unit === 0x3F ? ANY : canonical(unit)
  })
  const wild = units.some((unit) => unit < 0)
  const skip = (places) => {
    for (let i = 0; i < units.length; i++) if (places[i] === 1 && units[i] === STAR) places[i + 1] = 1
  }
  let here = new Uint8Array(units.length + 1)
  let next = new Uint8Array(units.length + 1)
  const test = (name) => {
    if ((traversal && (name === '.' || name === '..')) || (!empty && name === '')) return false
    if (lookahead && (name === '' || LINE_TERMINATORS.has(name.codePointAt(0)))) return false
    if (!wild && name.length !== units.length) return false
    here.fill(0)
    here[0] = 1
    skip(here)
    for (let k = 0; k < name.length; k++) {
      const unit = unitAt(name, k)
      next.fill(0)
      for (let i = 0; i < units.length; i++) {
        if (here[i] === 0) continue
        if (units[i] === STAR) {
          if (unit !== SLASH) next[i] = 1
        } else if (units[i] === ANY ? unit !== SLASH : canonical(unit) === units[i]) next[i + 1] = 1
      }
      skip(next)
      ;[here, next] = [next, here]
    }
    return here[units.length] === 1
  }
  return { test }
}

const foldless = (text) => text.toUpperCase() === text.toLowerCase()

// minimatch 10's own tests of a part, which it runs in place of its regexp.
const FAST = [
  [/^\*+$/u, () => (f) => f.length !== 0 && f !== '.' && f !== '..'],
  [/^\*+([^!(*+?@[]*)$/u, ([, ext]) => (f) => f.toLowerCase().endsWith(ext.toLowerCase())],
  [/^\?+([^!(*+?@[]*)?$/u, ([whole, ext]) => (f) => f.length === whole.length && f !== '.' && f !== '..' && (!ext || f.toLowerCase().endsWith(ext.toLowerCase()))],
  [/^\*+\.\*+$/u, () => (f) => f !== '.' && f !== '..' && f.includes('.')],
  [/^\.\*+$/u, () => (f) => f !== '.' && f !== '..' && f.startsWith('.')],
]

// A part as minimatch 5 reads it, or with `ten` minimatch 10.
export function readPart(text, ten = false) {
  if (text === '**') return GLOBSTAR
  if (!/[*?]/u.test(text)) return text === '' || foldless(text) ? text : partOf(text)
  if (!ten) return partOf(text, { lookahead: true, traversal: /^[*?]/u.test(text) })
  const fast = FAST.find(([re]) => re.test(text))
  if (fast !== undefined) return { test: fast[1](text.match(fast[0])) }
  return partOf(text, { traversal: /^\.{0,2}[*?]/u.test(text), empty: !/^\*+$/u.test(text) })
}

const hit = (part, name) => (typeof part === 'string' ? name === part : part.test(name))
const traversal = (name) => name === '.' || name === '..'

// How a match ends where file, as long as `end`, or pattern runs out at
// `fi` and `pi`.
function ended(file, pattern, fi, pi, partial, end = file.length) {
  if (fi === end) return pi === pattern.length || partial
  return pi === pattern.length && fi === end - 1 && file[fi] === ''
}

// minimatch's #matchOne, of `file` as if cut at `end`.
function matchFlat(file, pattern, partial, fileIndex = 0, end = file.length) {
  let fi = fileIndex
  let pi = 0
  for (; fi < end && pi < pattern.length; fi++, pi++) {
    if (pattern[pi] === GLOBSTAR || !hit(pattern[pi], file[fi])) return false
  }
  return ended(file, pattern, fi, pi, partial, end)
}

// minimatch 5.1.6's matchOne: a `**` swallows each count of parts in turn,
// each try of what is left matched once here, which minimatch tries anew.
function matchOld(file, pattern, partial) {
  const memo = new Map()
  const from = (start, patternStart) => {
    const key = start * (pattern.length + 1) + patternStart
    if (!memo.has(key)) memo.set(key, step(start, patternStart))
    return memo.get(key)
  }
  const step = (start, patternStart) => {
    let fi = start
    let pi = patternStart
    for (; fi < file.length && pi < pattern.length; fi++, pi++) {
      if (pattern[pi] !== GLOBSTAR) {
        if (!hit(pattern[pi], file[fi])) return false
        continue
      }
      if (pi + 1 === pattern.length) return !file.slice(fi).some(traversal)
      let fr = fi
      for (; fr < file.length; fr++) {
        if (from(fr, pi + 1)) return true
        if (traversal(file[fr])) break
      }
      return partial && fr === file.length
    }
    return ended(file, pattern, fi, pi, partial)
  }
  return from(0, 0)
}

// minimatch 5.1.9's and 10's: a head, a tail, and the sections between `**`s.
function matchNew(file, pattern, partial) {
  if (!pattern.includes(GLOBSTAR)) return matchFlat(file, pattern, partial)
  const first = pattern.indexOf(GLOBSTAR)
  const last = pattern.lastIndexOf(GLOBSTAR)
  const head = pattern.slice(0, first)
  const body = partial ? pattern.slice(first + 1) : pattern.slice(first + 1, last)
  const tail = partial ? [] : pattern.slice(last + 1)
  if (head.length && !matchFlat(file, head, partial, 0, Math.min(file.length, head.length))) return false
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
  return Boolean(matchSections(file, { sections, after, partial, sawTail: tailMatch > 0, memo: new Map() }, fileIndex, 0))
}

// Whether the sections from `index` match from `fileIndex`: minimatch's
// answer, false, null where no later start can do, or true; each pair
// reckoned once here. minimatch gives up past 200 sections, which more
// than 100 `**` are refused before reaching.
function matchSections(file, walk, fileIndex, index) {
  const { sections, after, partial, sawTail, memo } = walk
  if (index === sections.length) {
    const rest = file.slice(fileIndex)
    return !rest.some(traversal) && (sawTail || rest.length > 0)
  }
  const key = fileIndex * (sections.length + 1) + index
  if (memo.has(key)) return memo.get(key)
  let found = partial || null
  const section = sections[index]
  for (let at = fileIndex; at <= after[index]; at++) {
    if (matchFlat(file, section, partial, at, Math.min(file.length, at + section.length))) {
      const sub = matchSections(file, walk, at + section.length, index + 1)
      if (sub !== false) {
        found = sub
        break
      }
    }
    if (traversal(file[at])) {
      found = false
      break
    }
  }
  memo.set(key, found)
  return found
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
  checkLength(pattern, where)
  const bangs = pattern.match(/^!*/u)[0].length
  const body = pattern.slice(bangs)
  const five = minimatch !== '10.2'
  if (body.replace(/^\//u, '') === '[object Object]') return fromParts(bangs % 2 === 1, [[...body.startsWith('/') ? [''] : [], five ? OBJECT_5 : OBJECT_10]], minimatch)
  checkGlob(body, where, { parent: true })
  const split = body.split(/\/+/u)
  const parts = five ? split : levelOne(split)
  checkParts(pattern, parts, where)
  return fromParts(bangs % 2 === 1, [parts], minimatch)
}

// The rules of lines as ignore-walk reads them, an ignore file's or those
// npm-packlist hands it: each line trimmed, and none of a blank one or a
// comment. A rule given made is kept as it is.
export function rulesOf(lines, minimatch, where) {
  return lines.flatMap((line) => (typeof line === 'string' ? line.split(/\r?\n/u).map((rule) => rule.trim()).filter((rule) => rule !== '' && !rule.startsWith('#')).map((rule) => compile(rule, minimatch, where)) : [line]))
}

// A path's parts, as minimatch splits it, and its last one that is not
// empty, which matchBase matches a pattern of one part against. Every rule
// splits the same few paths, so the last ones are kept.
const splits = new Map()
function splitOf(path) {
  let found = splits.get(path)
  if (found === undefined) {
    const file = path.split(/\/+/u)
    found = { file, base: [file.findLast(Boolean) ?? file[0]] }
    if (splits.size >= 1024) splits.clear()
    splits.set(path, found)
  }
  return found
}

// `globParts` are the patterns' parts, as text but for those given parsed;
// ignore-walk 8 reads them. `test(path, partial)` is whether one matches,
// with matchBase.
export function fromParts(negate, globParts, minimatch) {
  const set = globParts.map((parts) => parts.map((part) => (typeof part === 'string' ? readPart(part, minimatch === '10.2') : part)))
  const matchOne = minimatch === '5.1.6' ? matchOld : matchNew
  const test = (path, partial = false) => {
    if (path === '/' && partial) return true
    const { file, base } = splitOf(path)
    return set.some((pattern) => matchOne(pattern.length === 1 ? base : file, pattern, partial))
  }
  return { negate, globParts, set, test }
}

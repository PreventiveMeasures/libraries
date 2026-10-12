// Changed lines read word by word: what changed within a line, which removed
// line was edited into which added one, and whether two lines differ in
// short names alone, as a minifier renames them.

import { changeSet } from '@preventive/diff'
import { checkLineOptions } from './text.js'

// Words as a word diff compares them, so `foo(a)` -> `foo(b)` marks `a` alone.
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu
// Past these a word diff is noise (minified lines) or too slow to be worth it.
const MAX_CHARS = 2000
const MAX_TOKENS = 800
// Lines whose words are mostly replaced are not one line edited.
const MAX_CHANGED = 0.6
// How far ahead a removed line looks for its counterpart, and the longest
// change whose lines are paired at all.
const LOOKAHEAD = 6
const MAX_LINES = 200

function mergeRanges(ranges, text) {
  const merged = []
  for (const [from, to] of ranges) {
    const last = merged.at(-1)
    if (last && /^\s*$/u.test(text.slice(last[1], from))) last[1] = to
    else merged.push([from, to])
  }
  return merged
}

// The ranges `[from, to)` that changed on each side, those split by whitespace
// alone merged, and the smaller share of either line they cover; null past the
// size limits. Each distinct token is one line of the diff, named by number.
function wordChanges(left, right) {
  if (left.length > MAX_CHARS || right.length > MAX_CHARS) return null
  const lt = left.match(TOKEN) ?? [], rt = right.match(TOKEN) ?? []
  if (lt.length > MAX_TOKENS || rt.length > MAX_TOKENS) return null
  const ids = new Map()
  const encode = (tokens) => tokens.map((token) => {
    if (!ids.has(token)) ids.set(token, String(ids.size))
    return `${ids.get(token)}\n`
  }).join('')
  const blocks = changeSet(encode(lt), encode(rt), { horizon: 0 })
  const ranges = (side, tokens, line) => {
    const at = [0]
    for (const token of tokens) at.push(at.at(-1) + token.length)
    return mergeRanges(blocks.filter((block) => block[`${side}1`] > block[`${side}0`]).map((block) => [at[block[`${side}0`]], at[block[`${side}1`]]]), line)
  }
  const a = ranges('a', lt, left), b = ranges('b', rt, right)
  const share = (list, line) => list.reduce((sum, [from, to]) => sum + to - from, 0) / Math.max(1, line.length)
  return { a, b, share: Math.min(share(a, left), share(b, right)) }
}

export function wordRanges(left, right) {
  if (left === right) return null
  const words = wordChanges(left, right)
  return words && words.share <= MAX_CHANGED ? { a: words.a, b: words.b } : null
}

export function pairLines(olds, news) {
  const pairs = []
  if (olds.length > MAX_LINES || news.length > MAX_LINES) return pairs
  let next = 0
  for (let i = 0; i < olds.length && next < news.length; i++) {
    let best = null, least = Infinity
    for (let j = next; j < Math.min(news.length, next + LOOKAHEAD) && least > 0; j++) {
      const words = olds[i] === news[j] ? { share: 0 } : wordChanges(olds[i], news[j])
      if (words && words.share <= MAX_CHANGED && words.share < least) {
        best = j
        least = words.share
      }
    }
    if (best !== null) {
      pairs.push([i, best])
      next = best + 1
    }
  }
  return pairs
}

// A line's words for renamedAlone: a comment, string or template to the
// line's end at most, a name, whitespace, a regular expression, or a character.
const LINE_WORD = /\/\/.*|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|[A-Za-z_$][\w$]*|\s+|[^]/uy
const REGEX_WORD = /\/(?:[^/\\[]|\\.|\[(?:[^\]\\]|\\.)*\]?)*\/?[A-Za-z]*/uy
// Words after which an expression starts, so a `/` starts a regular expression.
const BEFORE_EXPRESSION = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])
const SHORT_NAME = /^[A-Za-z_$][\w$]{0,2}$/u
const SHORT_KEYWORDS = new Set(['as', 'do', 'for', 'get', 'if', 'in', 'let', 'new', 'of', 'set', 'try', 'var'])

// A `/` divides only after a name (none of BEFORE_EXPRESSION), a number or a
// `]`; anywhere else it is read as a regular expression's, whole, so that no
// name in one is read as a variable's: a division so read keeps the rest whole.
function lineWords(line, blanks) {
  const words = []
  LINE_WORD.lastIndex = 0
  for (let prior = ''; LINE_WORD.lastIndex < line.length;) {
    const at = LINE_WORD.lastIndex
    let [word] = LINE_WORD.exec(line)
    if (word === '/' && prior !== ']' && !(/^[\w$]+$/u.test(prior) && !BEFORE_EXPRESSION.has(prior))) {
      REGEX_WORD.lastIndex = at;
      [word] = REGEX_WORD.exec(line)
      LINE_WORD.lastIndex = at + word.length
    }
    if (/\S/u.test(word)) prior = word
    if (blanks || /\S/u.test(word)) words.push(word)
  }
  return words
}

export function renamedAlone(before, after, options) {
  const blanks = checkLineOptions(options).whitespace !== 'all'
  const [x, y] = [lineWords(before, blanks), lineWords(after, blanks)]
  if (x.length !== y.length) return false
  const near = (list, from, step) => {
    for (let k = from; k >= 0 && k < list.length; k += step) if (/\S/u.test(list[k])) return list[k]
    return ''
  }
  let changed = false
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue
    if (![x[i], y[i]].every((word) => SHORT_NAME.test(word) && !SHORT_KEYWORDS.has(word))) return false
    if ([x, y].some((list) => ['.', '#'].includes(near(list, i - 1, -1)) || near(list, i + 1, 1) === ':')) return false
    changed = true
  }
  return changed
}

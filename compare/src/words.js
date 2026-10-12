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
const LINE_WORD = /\/\/.*|\/\*.*?(?:\*\/|$)|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|[A-Za-z_$][\w$]*|\s+|[^]/uy
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

// Words a name may follow in a script (`var a`, `return a`): one after any other name or a string is
// a JSX tag's or attribute's.
const BEFORE_NAME = new Set('var let const function class import return typeof void delete new in of instanceof case else do throw yield await export default extends async break continue'.split(' '))
// Words after which a `{` opens an object or a pattern, not a block or a class's body.
const OBJECT_AFTER = new Set('return = ( , : [ ? | & ! const let var export import of in yield await'.split(' '))

// Each bracket's index to its closing one's, and each word's innermost open bracket.
function brackets(list) {
  const close = new Map(), open = [], opener = new Int32Array(list.length)
  list.forEach((word, k) => {
    opener[k] = open.at(-1) ?? -1
    if (word.length === 1 && '([{'.includes(word)) open.push(k)
    else if (word.length === 1 && ')]}'.includes(word) && open.length > 0) close.set(open.pop(), k)
  })
  return { close, opener }
}

export function renamedAlone(before, after, options) {
  const blanks = checkLineOptions(options).whitespace !== 'all'
  const [x, y] = [lineWords(before, blanks), lineWords(after, blanks)]
  if (x.length !== y.length) return false
  const at = (list, from, step) => {
    let k = from
    while (k >= 0 && k < list.length && !/\S/u.test(list[k])) k += step
    return k
  }
  const near = (list, from, step) => list[at(list, from, step)] ?? ''
  const read = new Map([x, y].map((list) => [list, brackets(list)]))
  // A method's name, as a class's or an object's: `(`, its parameters and `{` after it, no `function` before.
  const method = (list, i) => {
    const open = at(list, i + 1, 1), prior = at(list, i - 1, -1)
    return list[open] === '(' && near(list, (read.get(list).close.get(open) ?? list.length) + 1, 1) === '{' && near(list, list[prior] === '*' ? prior - 1 : prior, -1) !== 'function'
  }
  const assigned = (list, k) => list[k] === '=' && !['=', '>'].includes(near(list, k + 1, 1))
  // A shorthand property's name (`{a}`, `const {a = 1} = x`), its key's too.
  const shorthand = (list, i) => {
    const next = at(list, i + 1, 1), opener = read.get(list).opener[i]
    return list[opener] === '{' && ['{', ','].includes(near(list, i - 1, -1)) && OBJECT_AFTER.has(near(list, opener - 1, -1))
      && (['}', ','].includes(list[next]) || assigned(list, next))
  }
  // A public field's name (`class X{a=1}`): in a body whose `{` has `class` before it, back to a `{`, `}` or `;`.
  const field = (list, i) => {
    const next = at(list, i + 1, 1), opener = read.get(list).opener[i]
    if (list[opener] !== '{' || !['{', ';', '}', 'static'].includes(near(list, i - 1, -1)) || !(['}', ';'].includes(list[next]) || assigned(list, next))) return false
    for (let k = opener - 1; k >= 0 && !['{', '}', ';'].includes(list[k]); k--) if (list[k] === 'class') return true
    return false
  }
  // After another name or a string (a JSX attribute), or beside `as` (an alias a module imports or exports by).
  const aside = (list, i) => {
    const prior = near(list, i - 1, -1)
    return (/^[A-Za-z_$][\w$]*$/u.test(prior) && !BEFORE_NAME.has(prior)) || /^["'`]/u.test(prior) || near(list, i + 1, 1) === 'as'
  }
  let changed = false
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue
    if (![x[i], y[i]].every((word) => SHORT_NAME.test(word) && !SHORT_KEYWORDS.has(word))) return false
    if ([x, y].some((list) => ['.', '#'].includes(near(list, i - 1, -1)) || near(list, i + 1, 1) === ':' || method(list, i) || shorthand(list, i) || field(list, i) || aside(list, i))) return false
    changed = true
  }
  return changed
}

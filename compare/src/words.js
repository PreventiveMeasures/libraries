// Changed lines read word by word: what changed within a line and the one it
// pairs with, as one shortest edit script between their words finds it.

import { scripter } from './script.js'

// Words as a word diff compares them, so `foo(a)` -> `foo(b)` marks `a` alone.
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu
// Past these a word diff is noise (minified lines) or too slow to be worth it.
const MAX_CHARS = 2000
const MAX_TOKENS = 800
// Lines whose words are mostly replaced are not one line edited.
export const MAX_CHANGED = 0.6

function mergeRanges(ranges, text) {
  const merged = []
  for (const [from, to] of ranges) {
    const last = merged.at(-1)
    if (last && /^\s*$/u.test(text.slice(last[1], from))) last[1] = to
    else merged.push([from, to])
  }
  return merged
}

// The words of the lines compared, numbered as first met, with each one's
// length and whether it is blank.
export const lexicon = () => ({ numbers: new Map(), lengths: [], blanks: [] })

// A line as a word diff reads it, each distinct word numbered in `words`; null
// past the size limits.
export function tokenized(line, words) {
  if (line.length > MAX_CHARS) return null
  const tokens = line.match(TOKEN) ?? []
  if (tokens.length > MAX_TOKENS) return null
  return { line, tokens, words: tokens.map((token) => {
    if (!words.numbers.has(token)) {
      words.numbers.set(token, words.lengths.length)
      words.lengths.push(token.length)
      words.blanks.push(/^\s/u.test(token))
    }
    return words.numbers.get(token)
  }) }
}

// The smaller share of either line a script changed, as a word view marks it;
// all of it where they share no word.
export const changedShare = ({ kept, seen }, left, right) => (seen
  ? Math.min(1 - kept[0] / Math.max(1, left.line.length), 1 - kept[1] / Math.max(1, right.line.length)) : 1)

// A line's changes as ranges `[from, to)`, those split by blanks alone merged.
function changedRanges({ tokens, line }, kept) {
  const ranges = []
  for (let at = 0, i = 0; i < tokens.length; at += tokens[i++].length) {
    if (kept[i]) continue
    if (ranges.at(-1)?.[1] === at) ranges.at(-1)[1] = at + tokens[i].length
    else ranges.push([at, at + tokens[i].length])
  }
  return mergeRanges(ranges, line)
}

// Lines the same have no ranges, not null: null is a line with no word view.
export function wordRanges(left, right) {
  if (left === right) return { a: [], b: [] }
  const words = lexicon()
  const a = tokenized(left, words), b = tokenized(right, words)
  if (a === null || b === null) return null
  const kept = { a: new Uint8Array(a.words.length), b: new Uint8Array(b.words.length) }
  const script = scripter(Math.max(a.words.length, b.words.length), words.lengths, words.blanks)(a.words, b.words, kept)
  return changedShare(script, a, b) <= MAX_CHANGED ? { a: changedRanges(a, kept.a), b: changedRanges(b, kept.b) } : null
}

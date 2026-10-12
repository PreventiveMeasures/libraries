// Changed lines read word by word: what changed within a line and the one it
// pairs with, as one shortest edit script between their words finds it.

import { script } from './script.js'

// Words as a word diff compares them, so `foo(a)` -> `foo(b)` marks `a` alone.
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu
// Past these a word diff is noise (minified lines) or too slow to be worth it.
const MAX_CHARS = 2000
const MAX_TOKENS = 800
// Lines whose words are mostly replaced are not one line edited.
export const MAX_CHANGED = 0.6

// A line as a word diff reads it, each distinct word numbered in `ids` as the
// script compares them; null past the size limits.
export function tokenized(line, ids) {
  if (line.length > MAX_CHARS) return null
  const tokens = line.match(TOKEN) ?? []
  if (tokens.length > MAX_TOKENS) return null
  return { line, tokens, words: tokens.map((token) => {
    if (!ids.has(token)) ids.set(token, ids.size)
    return ids.get(token)
  }) }
}

// A line's words the script changed as ranges `[from, to)`, those split by blanks alone merged.
function changedRanges({ tokens, line }, kept) {
  const ranges = []
  for (let at = 0, i = 0; i < tokens.length; at += tokens[i++].length) {
    if (kept[i]) continue
    const last = ranges.at(-1)
    if (last && /^\s*$/u.test(line.slice(last[1], at))) last[1] = at + tokens[i].length
    else ranges.push([at, at + tokens[i].length])
  }
  return ranges
}

const part = (ranges, line) => ranges.reduce((sum, [from, to]) => sum + to - from, 0) / Math.max(1, line.length)

// What a word view marks in two lines read: the ranges, the smaller share of
// either they cover (all of it where the script keeps no word), and the work.
export function wordView(a, b) {
  const kept = { a: a.words.map(() => 0), b: b.words.map(() => 0) }
  const steps = script(a.words, b.words, kept)
  const ranges = { a: changedRanges(a, kept.a), b: changedRanges(b, kept.b) }
  return { ranges, share: kept.a.includes(1) ? Math.min(part(ranges.a, a.line), part(ranges.b, b.line)) : 1, steps }
}

// Lines the same have no ranges, not null: null is a line with no word view.
export function wordRanges(left, right) {
  if (left === right) return { a: [], b: [] }
  const ids = new Map()
  const a = tokenized(left, ids), b = tokenized(right, ids)
  if (a === null || b === null) return null
  const { ranges, share } = wordView(a, b)
  return share <= MAX_CHANGED ? ranges : null
}

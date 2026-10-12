// Changed lines read word by word: what changed within a line and the one it
// pairs with.

import { changeSet } from '@preventive/diff'

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

// A line as a word diff reads it, each distinct word numbered in `known` (one
// for the lines compared) and written as one line of a diff; null past the
// size limits.
export function tokenized(line, known) {
  if (line.length > MAX_CHARS) return null
  const tokens = line.match(TOKEN) ?? []
  if (tokens.length > MAX_TOKENS) return null
  const words = tokens.map((token) => {
    if (!known.has(token)) known.set(token, known.size)
    return known.get(token)
  })
  return { line, tokens, words, encoded: words.map((word) => `${word}\n`).join('') }
}

// The ranges `[from, to)` that changed on each side of two tokenized lines,
// those split by whitespace alone merged, and the smaller share of either line
// they cover, all of it where the lines share no word.
export function wordChanges(left, right) {
  const blocks = changeSet(left.encoded, right.encoded, { horizon: 0 })
  const ranges = (side, { tokens, line }) => {
    const at = [0]
    for (const token of tokens) at.push(at.at(-1) + token.length)
    return mergeRanges(blocks.filter((block) => block[`${side}1`] > block[`${side}0`]).map((block) => [at[block[`${side}0`]], at[block[`${side}1`]]]), line)
  }
  const a = ranges('a', left), b = ranges('b', right)
  const share = (list, line) => list.reduce((sum, [from, to]) => sum + to - from, 0) / Math.max(1, line.length)
  const shared = left.tokens.length > blocks.reduce((sum, { a0, a1 }) => sum + a1 - a0, 0)
  return { a, b, share: shared ? Math.min(share(a, left.line), share(b, right.line)) : 1 }
}

// Lines the same have no ranges, not null: null is a line with no word view.
export function wordRanges(left, right) {
  if (left === right) return { a: [], b: [] }
  const known = new Map()
  const a = tokenized(left, known), b = tokenized(right, known)
  const words = a && b ? wordChanges(a, b) : null
  return words && words.share <= MAX_CHANGED ? { a: words.a, b: words.b } : null
}

// Changed lines read word by word: what changed within a line, and which
// removed line was edited into which added one.

import { changeSet } from '@preventive/diff'

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

// Which old variable became which new one: each pair of lines, as the diff of
// their keys (names set aside) pairs them, counts its variables as standing for
// each other, and two each the other's most counted pair, a tie pairing neither.

import { changeSet } from '@preventive/diff'

// Unchanged lines between changes that pair as unchanged ones, not as changed.
const ANCHORED_RUN = 3

// Whitespace alone never tells a name apart.
const changes = (a, b) => changeSet(a, b, { horizon: 0, whitespace: 'all' })

// A text's lines with its renamable variables' names set aside (`key`), and
// each line's such variables in order (`lines`).
function keyed(text, { occurrences }) {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const lines = starts.map(() => [])
  let at = 0, key = '', line = 0
  for (const [node, variable] of occurrences) {
    if (!variable.aside) continue
    key += text.slice(at, node.start)
    at = node.end
    while (line + 1 < starts.length && starts[line + 1] <= node.start) line++
    lines[line].push(variable)
  }
  return { key: key + text.slice(at), lines }
}

const tallies = () => ({ backward: new Map(), forward: new Map() })
function count(map, from, to) {
  if (!map.has(from)) map.set(from, new Map())
  map.get(from).set(to, (map.get(from).get(to) ?? 0) + 1)
}

// Pairs of lines counted, a long run of unchanged ones apart from the rest. In
// a change of unlike lengths, lines alike but for a final `;` or `,` pair (a
// declaration others now follow: `let t = ...;` -> `let t = ...,`).
function tallied(ka, kb) {
  const changed = tallies(), unchanged = tallies()
  // Lines reading variables one side has and the other not say nothing.
  const tally = ({ backward, forward }, pa, pb) => {
    const news = kb.lines[pb], olds = ka.lines[pa]
    if (olds.length !== news.length) return
    olds.forEach((variable, k) => {
      count(forward, variable, news[k])
      count(backward, news[k], variable)
    })
  }
  const keysA = ka.key.split('\n'), keysB = kb.key.split('\n')
  const trimmed = (lines, from, to) => `${lines.slice(from, to).map((line) => line.replace(/[;,]\s*$/u, '')).join('\n')}\n`
  let i = 0, j = 0
  for (const block of [...changes(ka.key, kb.key), { a0: ka.lines.length, a1: ka.lines.length, b0: kb.lines.length, b1: kb.lines.length }]) {
    const anchored = block.a0 - i >= ANCHORED_RUN
    while (i < block.a0) tally(anchored ? unchanged : changed, i++, j++)
    const [olds, news] = [block.a1 - block.a0, block.b1 - block.b0]
    if (olds === news) for (let k = 0; k < olds; k++) tally(changed, block.a0 + k, block.b0 + k)
    else if (olds > 0 && news > 0) {
      let x = 0, y = 0
      for (const inner of [...changes(trimmed(keysA, block.a0, block.a1), trimmed(keysB, block.b0, block.b1)), { a0: olds, a1: olds, b0: news, b1: news }]) {
        while (x < inner.a0) tally(changed, block.a0 + x++, block.b0 + y++)
        x = inner.a1
        y = inner.b1
      }
    }
    i = block.a1
    j = block.b1
  }
  return { changed, unchanged }
}

// The most counted of those not yet paired, none where two tie.
function best(counts, taken) {
  let found = null, most = 0
  for (const [other, n] of counts) {
    if (taken(other)) continue
    if (n > most) {
      found = other
      most = n
    } else if (n === most) found = null
  }
  return found
}

// Pairs each the other's best, into `map`, until none more pair.
function matched({ backward, forward }, { map, paired }, eligible = () => true) {
  const chosen = []
  for (let more = true; more;) {
    more = false
    for (const [variable, counts] of forward) {
      if (map.has(variable)) continue
      const to = best(counts, (other) => paired.has(other))
      if (!to || best(backward.get(to), (other) => map.has(other)) !== variable || !eligible(variable, to)) continue
      map.set(variable, to)
      paired.add(to)
      chosen.push(variable)
      more = true
    }
  }
  return chosen
}

// Unchanged lines pair first; changed ones then pair only what those say
// nothing of, as `weak` pairs, the first to give way where names read wrongly.
export function pairing(before, after, a, b) {
  const { changed, unchanged } = tallied(keyed(before, a), keyed(after, b))
  const found = { map: new Map(), paired: new Set() }
  matched(unchanged, found)
  const weak = new Set(matched(changed, found, (old, to) => !unchanged.forward.has(old) && !unchanged.backward.has(to)))
  return { map: found.map, weak }
}

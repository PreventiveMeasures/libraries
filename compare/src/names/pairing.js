// Which old variable became which new one. Every pair of lines counts each
// variable as standing for the other in it, and an old variable and a new one
// pair where each is the other's most counted of those not yet paired, a tie
// pairing neither, until none more do: a stray pair of lines (`e = a;` beside
// another function's `e = n;`) outweighed, and one paired leaving the next
// its due (`var a, b; f(a); g(b)` -> `var c, d; f(c); g(c)` pairs a with c,
// then b with d). Lines pair as the diff of their keys has them unchanged;
// then, for variables those say nothing of, the lines of a change of as many
// lines on each side, in order (`n => n * 2` -> `n => n * 3`), which can so
// never undo what unchanged lines say: those so paired are `weak`, the first
// to give way where names would read wrongly.

import { changeSet } from '@preventive/diff'

// The fewest unchanged lines in a row between changes whose pairs count as
// unchanged lines do in pairing variables.
const ANCHORED_RUN = 3

// Lines differing in whitespace alone pair too: it never tells a name apart.
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

// Each pair of lines counted, unchanged ones apart from changed ones. A short
// run of unchanged lines between changes may pair two alike lines of
// different places (`function K(t, e) {` with an added `function ls(t, e) {`,
// their names set aside): told as a changed line is. In a change of unlike
// lengths, its lines that read alike but for a final `;` or `,` (a
// declaration others now follow: `let t = ...;` -> `let t = ...,`) pair as
// their own diff has them, in order.
function tallied(ka, kb) {
  const changed = tallies(), unchanged = tallies()
  // A pair reading variables on one side its other does not (`{ a }`
  // declared on one alone) says nothing of which became which.
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

// Pairs from counts, into `map`, until none more pair; those paired.
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

export function pairing(before, after, a, b) {
  const { changed, unchanged } = tallied(keyed(before, a), keyed(after, b))
  const found = { map: new Map(), paired: new Set() }
  matched(unchanged, found)
  const weak = new Set(matched(changed, found, (old, to) => !unchanged.forward.has(old) && !unchanged.backward.has(to)))
  return { map: found.map, weak }
}

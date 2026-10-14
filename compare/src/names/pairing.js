// Which old variable became which new one: each pair of lines, as the diff of
// their keys (names set aside) pairs them, counts its variables as standing for
// each other, and two each the other's most counted pair, a tie pairing neither.

import { changeSet } from '@preventive/diff'
import { RESERVED } from './syntax.js'

// Unchanged lines between changes that pair as unchanged ones, not as changed.
const ANCHORED_RUN = 3

// Whitespace alone never tells a name apart.
const changes = (a, b, minimal = false) => changeSet(a, b, { horizon: 0, whitespace: 'all', minimal })

// The search's cutoff can face a run with lines alike far from its own: old code
// that a block of new code now comes before, its lines faced with that block's
// braces. The shortest diff instead, where its cost, lines by lines changed, allows.
const MINIMAL_COST = 2e8
function linedUp(a, b, lines) {
  const quick = changes(a, b)
  const changed = quick.reduce((n, { a0, a1, b0, b1 }) => n + a1 - a0 + b1 - b0, 0)
  return lines * changed > MINIMAL_COST ? quick : changes(a, b, true)
}

// A text's lines with its renamable variables' names set aside (`key`), but
// those `written` names (a pair found), each line's variables set aside in
// order (`lines`), and where in its key each stood (`places`).
function keyed(text, { occurrences }, written = () => null) {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const lines = starts.map(() => []), places = starts.map(() => [])
  let at = 0, key = '', line = 0, removed = 0
  for (const [node, variable] of occurrences) {
    if (!variable.aside) continue
    const name = written(variable)
    for (; line + 1 < starts.length && starts[line + 1] <= node.start; line++) removed = 0
    if (name === null) {
      lines[line].push(variable)
      places[line].push(node.start - starts[line] - removed)
    }
    key += text.slice(at, node.start) + (name ?? '')
    removed += node.end - node.start - (name?.length ?? 0)
    at = node.end
  }
  key += text.slice(at)
  return { key, keys: key.split('\n'), lines, places }
}

// Lines as a diff that sets whitespace aside compares them.
const SPACE = /[ \t\n\v\f\r]/gu
const plain = (lines) => lines.map((line) => line.replace(SPACE, ''))

// The kept lines of each side a run of changes could stand in place of: a run
// bordered by lines alike its own may sit anywhere along them short of the next
// run, as diff slides it, so which of those it leaves kept, facing which, is
// the diff's pick and says nothing (a function added before one written alike
// with names set aside: either's header may face the old one's) -- unless the
// line it would keep instead reads the same variables (`same`), which say
// the same either way.
function slack(a, b, blocks, sameA, sameB) {
  const loose = (lines, runs, same) => {
    const flags = new Uint8Array(lines.length)
    runs.forEach(([start, end], k) => {
      const ceiling = runs[k + 1]?.[0] ?? lines.length, floor = k > 0 ? runs[k - 1][1] : 0
      for (let e = end, s = start; s > floor && lines[s - 1] === lines[e - 1]; s--, e--) if (!same(s - 1, e - 1)) flags[s - 1] = 1
      for (let e = end, s = start; e < ceiling && lines[s] === lines[e]; s++, e++) if (!same(e, s)) flags[e] = 1
    })
    return flags
  }
  return [loose(a, blocks.filter(({ a0, a1 }) => a1 > a0).map(({ a0, a1 }) => [a0, a1]), sameA),
    loose(b, blocks.filter(({ b0, b1 }) => b1 > b0).map(({ b0, b1 }) => [b0, b1]), sameB)]
}

// Whether two of a run's lines, from `from`, read the same variables in order.
const reading = (k, from = 0) => (x, y) => {
  const one = k.lines[from + x], other = k.lines[from + y]
  return one.length === other.length && one.every((variable, n) => variable === other[n])
}

// The pairs of lines a diff of `a` and `b` keeps, each told whether slack.
function* kept(a, b, sameA, sameB) {
  const text = (lines) => lines.map((line) => `${line}\n`).join('')
  const blocks = linedUp(text(a), text(b), a.length + b.length)
  const [looseA, looseB] = slack(a, b, blocks, sameA, sameB)
  let i = 0, j = 0
  for (const { a0, a1, b1 } of [...blocks, { a0: a.length, a1: a.length, b1: b.length }]) {
    for (; i < a0; i++, j++) yield [i, j, looseA[i] || looseB[j]]
    i = a1
    j = b1
  }
}

// A run of lines' tokens (`list`) and the variable each stands for (`at`): the
// place a variable stood one token alike any other's. Null past MAX_TOKENS.
const PLACE = '*', TOKEN = /[\p{ID_Continue}$\u200C\u200D]+|\S/gu
// A diff's cost grows faster than its length: a change of more tokens a side
// than this pairs by its lines alone.
const MAX_TOKENS = 20000
function tokens(k, from, to) {
  const at = [], list = []
  const add = (token, variable) => {
    list.push(token)
    at.push(variable)
    return list.length <= MAX_TOKENS
  }
  const text = (line, start, end) => {
    for (const [token] of k.keys[line].slice(start, end).matchAll(TOKEN)) if (!add(`=${token}`, null)) return false
    return true
  }
  for (let line = from; line < to; line++) {
    let start = 0
    for (const [n, place] of k.places[line].entries()) {
      if (!text(line, start, place) || !add(PLACE, k.lines[line][n])) return null
      start = place
    }
    if (!text(line, start)) return null
  }
  return { list, at }
}

// A word but a keyword: what ties tokens kept together to their own place, as
// punctuation and keywords alone line up any statement with any other.
const WORD = /^=[\p{ID_Start}$_]/u
const ties = (token) => WORD.test(token) && !RESERVED.has(token.slice(1))

// The variables of a change that its tokens, diffed, keep facing each other in
// a run of tokens kept together holding a word: its lines written anew, wrapped
// or ended otherwise (`let t = ...;` -> `let t = ...,`), or reading more
// variables or fewer (`f(a)` -> `f(b, c)`: none, `b` or `c` alike). Lines
// reordered line up by punctuation alone, `aa(a, b); bb(b);` ->
// `bb(y, z); aa(x);` facing `(a, b)` with `(y, z)`, which pairs nothing.
function placed(ka, a0, a1, kb, b0, b1) {
  const reads = (k, from, to) => k.lines.slice(from, to).some((line) => line.length > 0)
  if (!reads(ka, a0, a1) || !reads(kb, b0, b1)) return []
  const a = tokens(ka, a0, a1), b = a && tokens(kb, b0, b1)
  if (!b) return []
  const found = [], pairs = [...kept(a.list, b.list, (x, y) => a.at[x] === a.at[y], (x, y) => b.at[x] === b.at[y])]
  for (let end = 1, start = 0; start < pairs.length; start = end++) {
    while (end < pairs.length && pairs[end][0] === pairs[end - 1][0] + 1 && pairs[end][1] === pairs[end - 1][1] + 1) end++
    const run = pairs.slice(start, end)
    if (run.some(([x]) => ties(a.list[x]))) for (const [x, y, loose] of run) if (a.at[x] && !loose) found.push([a.at[x], b.at[y]])
  }
  return found
}

const tallies = () => ({ backward: new Map(), forward: new Map() })
function count(map, from, to) {
  if (!map.has(from)) map.set(from, new Map())
  map.get(from).set(to, (map.get(from).get(to) ?? 0) + 1)
}

// Code moved: the lines changes took out and those they put in, diffed on their
// own, a long run kept pairing as code moved out of order with the rest does.
function moves(ka, kb, blocks, alike) {
  const at = (ends) => blocks.flatMap((block) => Array.from({ length: block[ends[1]] - block[ends[0]] }, (_, k) => block[ends[0]] + k))
  const news = at(['b0', 'b1']), olds = at(['a0', 'a1'])
  const same = (k, lines) => (x, y) => reading(k)(lines[x], lines[y])
  const pairs = [...kept(plain(olds.map((i) => ka.keys[i])), plain(news.map((j) => kb.keys[j])), same(ka, olds), same(kb, news))]
  for (let end = 1, start = 0; start < pairs.length; start = end++) {
    while (end < pairs.length && pairs[end][0] === pairs[end - 1][0] + 1 && pairs[end][1] === pairs[end - 1][1] + 1) end++
    if (end - start >= ANCHORED_RUN) for (const [x, y, loose] of pairs.slice(start, end)) if (!loose) alike(ka.lines[olds[x]], kb.lines[news[y]])
  }
}

// Pairs of lines counted, a long run of unchanged ones apart from the rest, and
// apart from both the variables a change's tokens pair (`tokened`) and those of
// code moved (`moved`). Lines reading variables one side has and the other not
// say nothing. In a change of unlike lengths, lines alike but for a final `;` or
// `,` pair (a declaration others now follow: `let t = ...;` -> `let t = ...,`).
function tallied(ka, kb) {
  const changed = tallies(), moved = tallies(), tokened = tallies(), unchanged = tallies()
  const counted = ({ backward, forward }, variable, other) => {
    count(forward, variable, other)
    count(backward, other, variable)
  }
  const alike = (counts, olds, news) => olds.length === news.length && olds.forEach((variable, k) => counted(counts, variable, news[k]))
  const trimmed = (lines, from, to) => plain(lines.slice(from, to).map((line) => line.replace(/[;,]\s*$/u, '')))
  const blocks = linedUp(ka.key, kb.key, ka.keys.length + kb.keys.length)
  const [looseA, looseB] = slack(plain(ka.keys), plain(kb.keys), blocks, reading(ka), reading(kb))
  let i = 0, j = 0
  for (const block of [...blocks, { a0: ka.lines.length, a1: ka.lines.length, b0: kb.lines.length, b1: kb.lines.length }]) {
    const counts = block.a0 - i >= ANCHORED_RUN ? unchanged : changed
    for (; i < block.a0; i++, j++) if (!looseA[i] && !looseB[j]) alike(counts, ka.lines[i], kb.lines[j])
    const [olds, news] = [block.a1 - block.a0, block.b1 - block.b0]
    if (olds > 0 && news > 0) {
      if (olds === news) for (let k = 0; k < olds; k++) alike(changed, ka.lines[block.a0 + k], kb.lines[block.b0 + k])
      else {
        const pairs = kept(trimmed(ka.keys, block.a0, block.a1), trimmed(kb.keys, block.b0, block.b1), reading(ka, block.a0), reading(kb, block.b0))
        for (const [x, y] of [...pairs].filter((pair) => !pair[2])) alike(changed, ka.lines[block.a0 + x], kb.lines[block.b0 + y])
      }
      for (const [variable, other] of placed(ka, block.a0, block.a1, kb, block.b0, block.b1)) counted(tokened, variable, other)
    }
    i = block.a1
    j = block.b1
  }
  moves(ka, kb, blocks, (olds, news) => alike(moved, olds, news))
  return { changed, moved, tokened, unchanged }
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
// nothing of, and a change's tokens only what no line says anything of: lines
// reordered, a change's tokens may line up across them. Both are `weak` pairs,
// the first to give way where names read wrongly. A second pass reads the
// pairs found as names, so lines alike with every name set aside and diffed
// against the wrong one line up by those.
export function pairing(before, after, a, b) {
  const found = { map: new Map(), paired: new Set() }, said = new Set(), weak = new Set()
  const passes = [[() => null, () => null], [(variable) => found.map.get(variable)?.name ?? null, (variable) => (found.paired.has(variable) ? variable.name : null)]]
  for (const [old, now] of passes) {
    // A pass pairs nothing where every variable of a side is paired already.
    if (!a.variables.some((variable) => variable.aside && !found.map.has(variable)) || !b.variables.some((variable) => variable.aside && !found.paired.has(variable))) break
    const { changed, moved, tokened, unchanged } = tallied(keyed(before, a, old), keyed(after, b, now))
    for (const [counts, tier] of [[unchanged, false], [changed, true], [tokened, true], [moved, true]]) {
      for (const variable of matched(counts, found, (from, to) => !said.has(from) && !said.has(to))) if (tier) weak.add(variable)
      for (const variable of [...counts.forward.keys(), ...counts.backward.keys()]) said.add(variable)
    }
  }
  return { map: found.map, weak }
}

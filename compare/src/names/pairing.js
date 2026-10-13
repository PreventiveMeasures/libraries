// Which old variable became which new one: each pair of lines, as the diff of
// their keys (names set aside) pairs them, counts its variables as standing for
// each other, and two each the other's most counted pair, a tie pairing neither.

import { changeSet } from '@preventive/diff'

// Unchanged lines between changes that pair as unchanged ones, not as changed.
const ANCHORED_RUN = 3

// Whitespace alone never tells a name apart.
const changes = (a, b) => changeSet(a, b, { horizon: 0, whitespace: 'all' })

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
// with names set aside: either's header may face the old one's).
function slack(a, b, blocks) {
  const loose = (lines, runs) => {
    const flags = new Uint8Array(lines.length)
    runs.forEach(([start, end], k) => {
      const ceiling = runs[k + 1]?.[0] ?? lines.length, floor = k > 0 ? runs[k - 1][1] : 0
      for (let e = end, s = start; s > floor && lines[s - 1] === lines[e - 1]; s--, e--) flags[s - 1] = 1
      for (let e = end, s = start; e < ceiling && lines[s] === lines[e]; s++, e++) flags[e] = 1
    })
    return flags
  }
  return [loose(a, blocks.filter(({ a0, a1 }) => a1 > a0).map(({ a0, a1 }) => [a0, a1])), loose(b, blocks.filter(({ b0, b1 }) => b1 > b0).map(({ b0, b1 }) => [b0, b1]))]
}

// The pairs of lines a diff of `a` and `b` keeps, but those slack.
function* kept(a, b) {
  const text = (lines) => lines.map((line) => `${line}\n`).join('')
  const blocks = changes(text(a), text(b))
  const [looseA, looseB] = slack(a, b, blocks)
  let i = 0, j = 0
  for (const { a0, a1, b1 } of [...blocks, { a0: a.length, a1: a.length, b1: b.length }]) {
    for (; i < a0; i++, j++) if (!looseA[i] && !looseB[j]) yield [i, j]
    i = a1
    j = b1
  }
}

// A run of lines' tokens (`list`) and the variable each stands for (`at`): the
// place a variable stood one token alike any other's. Null past MAX_TOKENS.
const PLACE = '*', TOKEN = /[\p{ID_Continue}$\u200C\u200D]+|\S/gu
// A diff's cost grows faster than its length: a change of more tokens a side
// than this pairs its lines in order, as many as each other reading as many.
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

// The variables of a change that its tokens, diffed, keep facing each other:
// its lines written anew, wrapped or ended otherwise (`let t = ...;` ->
// `let t = ...,`), or reading more variables or fewer (`f(a)` -> `f(b, c)`:
// none, `b` or `c` alike).
function placed(ka, a0, a1, kb, b0, b1) {
  const reads = (k, from, to) => k.lines.slice(from, to).some((line) => line.length > 0)
  if (!reads(ka, a0, a1) || !reads(kb, b0, b1)) return []
  const a = tokens(ka, a0, a1), b = a && tokens(kb, b0, b1)
  if (b) return [...kept(a.list, b.list)].filter(([x]) => a.at[x]).map(([x, y]) => [a.at[x], b.at[y]])
  if (a1 - a0 !== b1 - b0) return []
  return ka.lines.slice(a0, a1).flatMap((olds, k) => (olds.length === kb.lines[b0 + k].length ? olds.map((variable, n) => [variable, kb.lines[b0 + k][n]]) : []))
}

const tallies = () => ({ backward: new Map(), forward: new Map() })
function count(map, from, to) {
  if (!map.has(from)) map.set(from, new Map())
  map.get(from).set(to, (map.get(from).get(to) ?? 0) + 1)
}

// Pairs of lines counted, a long run of unchanged ones apart from the rest,
// and the variables a change's tokens pair.
function tallied(ka, kb) {
  const changed = tallies(), unchanged = tallies()
  const counted = ({ backward, forward }, variable, other) => {
    count(forward, variable, other)
    count(backward, other, variable)
  }
  const alike = (counts, olds, news) => olds.forEach((variable, k) => counted(counts, variable, news[k]))
  const blocks = changes(ka.key, kb.key)
  const [looseA, looseB] = slack(plain(ka.keys), plain(kb.keys), blocks)
  let i = 0, j = 0
  for (const block of [...blocks, { a0: ka.lines.length, a1: ka.lines.length, b0: kb.lines.length, b1: kb.lines.length }]) {
    const counts = block.a0 - i >= ANCHORED_RUN ? unchanged : changed
    for (; i < block.a0; i++, j++) if (!looseA[i] && !looseB[j]) alike(counts, ka.lines[i], kb.lines[j])
    if (block.a1 > block.a0 && block.b1 > block.b0) for (const [variable, other] of placed(ka, block.a0, block.a1, kb, block.b0, block.b1)) counted(changed, variable, other)
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
// A second pass reads the pairs found as names, so lines alike with every name
// set aside and diffed against the wrong one line up by those.
export function pairing(before, after, a, b) {
  const found = { map: new Map(), paired: new Set() }, said = new Set(), weak = new Set()
  const passes = [[() => null, () => null], [(variable) => found.map.get(variable)?.name ?? null, (variable) => (found.paired.has(variable) ? variable.name : null)]]
  for (const [old, now] of passes) {
    // A pass pairs nothing where every variable of a side is paired already.
    if (!a.variables.some((variable) => variable.aside && !found.map.has(variable)) || !b.variables.some((variable) => variable.aside && !found.paired.has(variable))) break
    const { changed, unchanged } = tallied(keyed(before, a, old), keyed(after, b, now))
    matched(unchanged, found)
    for (const variable of [...unchanged.forward.keys(), ...unchanged.backward.keys()]) said.add(variable)
    for (const variable of matched(changed, found, (from, to) => !said.has(from) && !said.has(to))) weak.add(variable)
  }
  return { map: found.map, weak }
}

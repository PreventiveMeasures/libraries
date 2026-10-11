// Pairs of trees made at random, from a seed, for comparing against git: a
// tree, and the same tree after the kinds of thing a commit does to one --
// files edited, moved, moved and edited, copied, deleted, added, made
// executable, turned into links. Same seed, same pair.
//
// The lines come from a pool of a few thousand, so a line seldom recurs by
// chance: diff and git then both find the one shortest change set, and agree
// on how many lines it adds and removes. Some lines run past 64 bytes, which
// git's similarity cuts into spans; some files end without a newline, or in
// CRLF, which git's similarity passes over.

const DIRS = ['', 'src/', 'src/util/', 'lib/', 'docs/', 'a b/', '\u{FC}/']
const NAMES = ['index.js', 'util.js', 'README', 'a.txt', 'b.txt', 'notes.md', 'x y.txt', '\u{E9}t\u{E9}.txt', 'q"uote', 'back\\slash', 'tab\there', '\u{1F600}.txt']

// mulberry32
export function random(seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (n) => Math.floor(next() * n)
  return { next, int, pick: (list) => list[int(list.length)], chance: (p) => next() < p }
}

function line(rng) {
  if (rng.chance(0.05)) return ''
  const id = rng.int(5000)
  return rng.chance(0.1) ? `${'long '.repeat(15 + rng.int(20))}${id}` : `line ${id}`
}

function content(rng) {
  if (rng.chance(0.05)) return ''
  const lines = Array.from({ length: 1 + rng.int(30) }, () => line(rng))
  const eol = rng.chance(0.1) ? '\r\n' : '\n'
  return lines.join(eol) + (rng.chance(0.15) ? '' : eol)
}

// Some lines replaced, some removed, some put in.
function edit(rng, text) {
  const lines = text.split('\n')
  for (let n = 1 + rng.int(3); n > 0; n--) {
    const at = rng.int(lines.length + 1)
    const what = rng.int(3)
    if (what === 0 && at < lines.length) lines[at] = line(rng)
    else if (what === 1 && at < lines.length) lines.splice(at, 1)
    else lines.splice(at, 0, line(rng))
  }
  return lines.join('\n')
}

const pathOf = (rng) => rng.pick(DIRS) + rng.pick(NAMES)

function file(rng) {
  if (rng.chance(0.06)) return { link: rng.pick(NAMES) }
  if (rng.chance(0.04)) return { data: Uint8Array.from({ length: 1 + rng.int(200) }, () => rng.int(256)).fill(0, 0, 1), mode: 0o644 }
  return { data: content(rng), mode: rng.chance(0.15) ? 0o755 : 0o644 }
}

function changed(rng, spec) {
  const what = rng.int(10)
  if (what < 4 && typeof spec.data === 'string') return { ...spec, data: edit(rng, spec.data) }
  if (what === 4 && !('link' in spec)) return { ...spec, mode: spec.mode === 0o755 ? 0o644 : 0o755 }
  if (what === 5) return 'link' in spec ? file(rng) : { link: rng.pick(NAMES) }
  return spec
}

// One pair: `old` and `new`, from path to file as tests/git.js takes them.
export function treePair(seed) {
  const rng = random(seed)
  const old = {}
  for (let n = 1 + rng.int(14); n > 0; n--) old[pathOf(rng)] = file(rng)
  const fresh = {}
  const free = (path) => !(path in fresh)
  for (const [path, spec] of Object.entries(old)) {
    const fate = rng.int(20)
    if (fate < 2) continue
    if (fate < 6) {
      const to = pathOf(rng)
      if (free(to)) fresh[to] = fate < 4 || typeof spec.data !== 'string' ? spec : { ...spec, data: edit(rng, spec.data) }
      continue
    }
    if (fate === 6) {
      const to = pathOf(rng)
      if (free(to)) fresh[to] = spec
    }
    if (free(path)) fresh[path] = fate < 12 ? spec : changed(rng, spec)
  }
  for (let n = rng.int(4); n > 0; n--) {
    const path = pathOf(rng)
    if (free(path)) fresh[path] = file(rng)
  }
  return { old, new: fresh }
}

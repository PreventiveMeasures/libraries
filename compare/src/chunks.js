// Bundle chunks a build renamed: `index-CyWAfh-p.js` for `index-hRvO4yU2.js`
// in one directory, the hash in a name following its content, and the same
// for `main.3f9a2c1d.chunk.js` or `index-CyWAfh-p.js.map`, extensions after
// the hash. Minified code is a line or a few, so a chunk is scored with spans
// ending after punctuation.

// A content hash: six or more of base64url's characters, not all lowercase
// letters, which a word is.
const HASH = /^[\w-]{6,}$/u
const RANDOM = /[\dA-Z]/u
const SEPARATORS = '-._'

function nameOf(path) {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  return { name, key: `${path.slice(0, slash + 1)}\0${extension}\0${name.length}` }
}

// Whether two names of a length are one chunk's, its hash all that differs:
// what follows the last separator they share before they differ, up to the
// first `.` of the end they share, their extensions.
function oneChunk(a, b) {
  let end = a.length, start = 0
  while (start < a.length && a[start] === b[start]) start++
  while (end > start && a[end - 1] === b[end - 1]) end--
  while (start > 0 && !SEPARATORS.includes(a[start - 1])) start--
  while (end < a.length && a[end] !== '.') end++
  const x = a.slice(start, end), y = b.slice(start, end)
  return start > 0 && HASH.test(x) && HASH.test(y) && (RANDOM.test(x) || RANDOM.test(y))
}

// Chunks git's scored pass has yet to claim, by directory, extension and
// name's length, each pair at least `bar`: the best first, as git takes its
// candidates, but for a pair `outdone` by a file's other candidate, set aside
// and returned, best first, for git to pair that candidate with another file.
export function chunkRenames({ sources, dests, pairs, used, record, punctuatedScoreOf }, { remaining, open }, bar, outdone) {
  const names = (files, indices) => new Map(indices.filter((i) => files[i].type === 'file').map((i) => [i, nameOf(files[i].path)]))
  const destNames = names(dests, open), sourceNames = names(sources, remaining)
  const byKey = Map.groupBy(sourceNames.keys(), (s) => sourceNames.get(s).key)
  const opens = Map.groupBy(destNames.keys(), (d) => destNames.get(d).key)
  const candidates = []
  for (const [key, ds] of opens) {
    const ss = byKey.get(key) ?? []
    for (const d of ds) {
      for (const s of ss) {
        if (!oneChunk(sourceNames.get(s).name, destNames.get(d).name)) continue
        const score = punctuatedScoreOf(s, d, bar)
        if (score >= bar) candidates.push({ s, d, score })
      }
    }
  }
  const aside = []
  for (const pair of candidates.sort((x, y) => y.score - x.score)) {
    if (pairs.has(pair.d) || used.has(pair.s)) continue
    if (outdone(pair)) aside.push(pair)
    else record(pair.d, pair.s, pair.score)
  }
  return aside
}

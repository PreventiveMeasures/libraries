// Bundle chunks a build renamed: `index-CyWAfh-p.js` for `index-hRvO4yU2.js`
// in one directory, the hash in a name following its content. Minified code
// is a line or a few, so a chunk is scored with spans ending after punctuation.

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
  const stem = name.slice(0, name.length - extension.length)
  return { stem, key: `${path.slice(0, slash + 1)}\0${extension}\0${stem.length}` }
}

// Whether two stems of a length are one chunk's, its hash all that differs:
// what follows the last separator they share before they differ.
function oneChunk(a, b) {
  let start = 0
  while (start < a.length && a[start] === b[start]) start++
  while (start > 0 && !SEPARATORS.includes(a[start - 1])) start--
  const x = a.slice(start), y = b.slice(start)
  return start > 0 && HASH.test(x) && HASH.test(y) && (RANDOM.test(x) || RANDOM.test(y))
}

// Chunks no other pass claimed, by directory, extension and name's length,
// each pair at least `bar`: the best first, as git takes its candidates.
export function chunkRenames({ sources, dests, pairs, used, record, punctuatedScoreOf }, { remaining, open }, bar, limit) {
  const names = (files, indices) => new Map(indices.filter((i) => files[i].type === 'file').map((i) => [i, nameOf(files[i].path)]))
  const destNames = names(dests, open), sourceNames = names(sources, remaining)
  const byKey = Map.groupBy(sourceNames.keys(), (s) => sourceNames.get(s).key)
  const opens = Map.groupBy(destNames.keys(), (d) => destNames.get(d).key)
  const candidates = []
  for (const [key, ds] of opens) {
    const ss = byKey.get(key) ?? []
    if (ss.length * ds.length > limit * limit) continue
    for (const d of ds) {
      for (const s of ss) {
        if (!oneChunk(sourceNames.get(s).stem, destNames.get(d).stem)) continue
        const score = punctuatedScoreOf(s, d, bar)
        if (score >= bar) candidates.push({ s, d, score })
      }
    }
  }
  for (const { s, d, score } of candidates.sort((x, y) => y.score - x.score)) {
    if (!pairs.has(d) && !used.has(s)) record(d, s, score)
  }
}

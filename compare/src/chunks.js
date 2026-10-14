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

// A name's readings as one a build gave a hash, `[name]-[hash]` or
// `[name].[contenthash]`, the shortest hash first: `[name, hash, extensions]`,
// the hash 8 to 32 of base64url's characters after a `-` or `.`, with a
// letter, and a digit or a capital, and only extensions after it. None for a
// date (`migration-20240101.js`) or a word (`lodash.debounce.js`).
const EXTENSIONS = /^(?:\.[A-Za-z\d]+)+$/u, HASHED = /^[\w-]{8,32}$/u
function readings(name) {
  const found = []
  for (let at = name.length - 1; at > 0; at--) {
    if (name[at] !== '-' && name[at] !== '.') continue
    const end = name.indexOf('.', at + 1), extensions = name.slice(end), hash = name.slice(at + 1, end)
    if (end !== -1 && HASHED.test(hash) && EXTENSIONS.test(extensions) && /[A-Za-z]/u.test(hash) && RANDOM.test(hash)) found.push([name.slice(0, at), hash, extensions])
  }
  return found
}

// Whether two names are one but for a hash: the shortest reading of one whose
// hash the other's reading with those extensions does not share, its name
// theirs. A part both share is an extension's (`index-AbCd1234.production2024.js`);
// a `-` in a hash is the hash's (`index-CyWAfh-p.js`, `codeMirrorModule--QdMvsKi.css`)
// and one before eight more the name's (`vendor-react-dom-AbCd1234.js`).
function oneButHash(a, b) {
  const others = readings(b)
  for (const [name, hash, extensions] of readings(a)) {
    const other = others.find((reading) => reading[2] === extensions)
    if (other && other[1] !== hash) return other[0] === name
  }
  return false
}

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
// name's length, each pair at least `bar` -- or however it scores, where each
// is the other's only such chunk and their names are one but for a hash
// (oneButHash), as a pair by path is: the build's own chunk, rewritten
// (playwright's dashboard `index-*.js`, 31% alike from 1.61 to 1.62):
// the best first, as git takes its candidates, but for a pair `outdone` by a
// file's other candidate, set aside and returned, best first, for git to pair
// that candidate with another file: it holds its files, so that a later pair
// of either is set aside behind it.
export function chunkRenames({ sources, dests, pairs, used, record, punctuatedScoreOf }, { remaining, open }, bar, outdone) {
  const names = (files, indices) => new Map(indices.filter((i) => files[i].type === 'file').map((i) => [i, nameOf(files[i].path)]))
  const destNames = names(dests, open), sourceNames = names(sources, remaining)
  const byKey = Map.groupBy(sourceNames.keys(), (s) => sourceNames.get(s).key)
  const opens = Map.groupBy(destNames.keys(), (d) => destNames.get(d).key)
  const chunks = []
  for (const [key, ds] of opens) {
    const ss = byKey.get(key) ?? []
    for (const d of ds) for (const s of ss) if (oneChunk(sourceNames.get(s).name, destNames.get(d).name)) chunks.push({ s, d })
  }
  const byDest = Map.groupBy(chunks, ({ d }) => d), bySource = Map.groupBy(chunks, ({ s }) => s)
  const candidates = []
  for (const { s, d } of chunks) {
    const only = bySource.get(s).length === 1 && byDest.get(d).length === 1 && oneButHash(sourceNames.get(s).name, destNames.get(d).name)
    const score = punctuatedScoreOf(s, d, only ? 0 : bar)
    if (only || score >= bar) candidates.push({ s, d, score })
  }
  const aside = [], heldDests = new Set(), heldSources = new Set()
  for (const pair of candidates.sort((x, y) => y.score - x.score)) {
    if (pairs.has(pair.d) || used.has(pair.s)) continue
    if (heldSources.has(pair.s) || heldDests.has(pair.d) || outdone(pair)) {
      aside.push(pair)
      heldSources.add(pair.s)
      heldDests.add(pair.d)
    } else record(pair.d, pair.s, pair.score)
  }
  return aside
}

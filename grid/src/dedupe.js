import { hashSeed, random } from './random.js'

// Near-duplicate entries, found before anything is compacted. A dataset of twenty thousand entries
// rarely holds twenty thousand distinct texts: the same document filed under several ids, a copy
// with a header changed, a revision a paragraph apart. Left alone, each copy is compacted (paid
// for once per copy), takes a seat on every page it lands on and in the finalist pool, and matches
// whatever its twin matches, so a topK of ten can be one entry ten times over. Here the copies are
// grouped once, by text alone and with no model call: buildTable compacts one of each group and
// marks the rest, select searches the one, and a result names the ids it stands for.
//
// The method is the standard one (Broder 1997; Leskovec, Rajaraman and Ullman, "Mining of Massive
// Datasets", ch. 3): a text as the set of its word shingles, Jaccard similarity between two sets as
// the measure, a MinHash signature per text so that the similarity of two is read off a few dozen
// integers, and banded locality-sensitive hashing so that only pairs likely to be similar are ever
// compared. Exact copies -- the same words, whatever the case and punctuation -- are grouped before
// any of that, by one hash of the folded text.
//
// Deterministic: the hash functions are fixed by a constant seed, so one dataset groups the same
// way on every run, and the first entry of a group in input order is its canonical one. Memory is
// one typed array of shingle hashes per distinct text (a few kilobytes for a few pages) and nothing
// per word: the folded words of a text are dropped as soon as its shingles are taken.

// The words of a text, case and punctuation folded away: a copy that differs by a comma is a copy.
export const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const FNV_OFFSET = 0x811C9DC5
const FNV_PRIME = 0x01000193

// The text as the sorted set of its 32-bit shingle hashes: each run of `k` words hashed as one,
// FNV-style over the words' own hashes so that a shingle costs k multiplies rather than a string.
// A text shorter than `k` words is one shingle, the whole of it; an empty text has none. Sorted
// and distinct, in a typed array -- twenty thousand entries of a few pages are sixteen million
// shingles, and a Set each would not fit where four bytes each do -- so that two texts' Jaccard is
// one merge pass over them.
export function shingles(list, k) {
  if (list.length === 0) return new Uint32Array(0)
  const wordHashes = Uint32Array.from(list, hashSeed)
  const span = Math.min(k, list.length)
  const count = list.length - span + 1
  const hashed = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    let h = FNV_OFFSET
    for (let j = 0; j < span; j++) h = Math.imul(h ^ wordHashes[i + j], FNV_PRIME)
    hashed[i] = h >>> 0
  }
  hashed.sort()
  let kept = 0
  for (let i = 0; i < hashed.length; i++) {
    if (i === 0 || hashed[i] !== hashed[i - 1]) {
      hashed[kept] = hashed[i]
      kept += 1
    }
  }
  return hashed.subarray(0, kept)
}

// |A ∩ B| / |A ∪ B| over two sorted distinct arrays; two empty sets count as identical.
export function jaccard(a, b) {
  let i = 0
  let j = 0
  let both = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      both += 1
      i += 1
      j += 1
    } else if (a[i] < b[j]) {
      i += 1
    } else {
      j += 1
    }
  }
  const union = a.length + b.length - both
  return union === 0 ? 1 : both / union
}

// murmur3's finaliser: a bijection on 32 bits that spreads one changed bit over all of them. One
// hash function per salt -- the shingle XOR the salt, mixed -- which is a multiply cheaper than the
// textbook (a·x + b) mod p in a language without 64-bit integers, and as good for taking a minimum
// over a set.
function mix(value) {
  let h = value >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85EBCA6B)
  h ^= h >>> 13
  h = Math.imul(h, 0xC2B2AE35)
  h ^= h >>> 16
  return h >>> 0
}

function saltsFor(count) {
  const rng = random(hashSeed('grid.dedupe'))
  return Uint32Array.from({ length: count }, () => Math.floor(rng() * 4294967296))
}

// The MinHash signature: under every hash function, the least value it takes over the set. Two
// sets' signatures agree in a position with probability equal to their Jaccard similarity, which is
// the whole trick.
function signature(set, salts) {
  const sig = new Uint32Array(salts.length).fill(0xFFFFFFFF)
  for (const shingle of set) {
    for (let i = 0; i < salts.length; i++) {
      const h = mix(shingle ^ salts[i])
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
}

// Disjoint sets over indices, the root of a set always its least index, so that the canonical
// entry of a group is the first of it in input order without a pass to pick one.
function unionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i)
  const find = (index) => {
    let i = index
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const unite = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  return { find, unite }
}

// Exact copies, by a 32-bit hash of the folded text and -- since twenty thousand texts stand a
// real chance of one hash collision among them -- the folded text itself recomputed on a hash
// match, so that a collision is two distinct texts and never a group. Returns the shingle sets of
// the distinct texts, by index; the folded words of each text live no longer than this loop.
function exactPass(entries, shingle, unite) {
  const seen = new Map()
  const sets = new Map()
  for (const [i, entry] of entries.entries()) {
    const list = words(entry.text)
    const joined = list.join(' ')
    const key = hashSeed(joined)
    const held = seen.get(key)
    const twin = held?.find((j) => words(entries[j].text).join(' ') === joined)
    if (twin === undefined) {
      if (held) held.push(i)
      else seen.set(key, [i])
      sets.set(i, shingles(list, shingle))
    } else {
      unite(twin, i)
    }
  }
  return sets
}

// How many distinct groups one bucket is compared against before the rest of its members are
// passed over. A bucket is a band's worth of signature, and a dataset built from one template
// (letters, tickets, listings) can land thousands of entries in one, most of them not copies of
// each other; comparing every member to every other would be the quadratic pass the hashing exists
// to avoid. A member that matches none of the first few groups seen in a bucket is still found
// through any other band it shares with its copy.
const REPRESENTATIVES = 8

// The near pass over the distinct texts: a signature each, banded into buckets, and each text
// compared -- by exact Jaccard; the signature only chose whom -- with the groups already in its
// buckets, united with the first one at or over the threshold.
function nearPass({ sets, threshold, hashes, bands, find, unite }) {
  const salts = saltsFor(hashes)
  const rows = hashes / bands
  const buckets = new Map()
  for (const [i, set] of sets) {
    const sig = signature(set, salts)
    for (let band = 0; band < bands; band++) {
      const key = `${band}:${sig.subarray(band * rows, (band + 1) * rows).join(',')}`
      const held = buckets.get(key)
      if (!held) {
        buckets.set(key, [i])
        continue
      }
      let matched = false
      for (const j of held) {
        if (find(j) === find(i)) {
          matched = true
          break
        }
        if (jaccard(sets.get(j), set) >= threshold) {
          unite(j, i)
          matched = true
          break
        }
      }
      if (!matched && held.length < REPRESENTATIVES) held.push(i)
    }
  }
}

function checkOptions({ threshold, shingle, hashes, bands }) {
  if (!(threshold > 0 && threshold <= 1)) throw new TypeError(`groupDuplicates: threshold must be in (0, 1], got ${threshold}`)
  if (!Number.isInteger(shingle) || shingle < 1) throw new TypeError(`groupDuplicates: shingle must be a whole number of words, got ${shingle}`)
  if (!Number.isInteger(hashes) || !Number.isInteger(bands) || hashes < 1 || bands < 1 || hashes % bands !== 0) {
    throw new TypeError(`groupDuplicates: hashes (${hashes}) must be a positive whole multiple of bands (${bands})`)
  }
}

// `entries` are `{ id, text }` with distinct ids. Returns the groups of two or more as a Map from
// the canonical id -- the first of the group in input order -- to the ids of its copies, in input
// order; an entry in no group is absent.
//
// `threshold` (0.8) is the Jaccard similarity over word `shingle`-grams (5) at which two texts are
// copies: at five words a shingle, one word changed in a hundred leaves them at 0.9, three words
// changed apart from each other at 0.73. `hashes` (64) and `bands` (16) shape the hashing: a pair
// shares a bucket when all `hashes / bands` positions of one band agree, which a pair at similarity
// s does with probability 1 - (1 - s^4)^16 -- all but certain at 0.8, one in sixteen at 0.3 --
// and the exact similarity then decides, so the defaults trade a few needless comparisons for
// missing next to nothing at the threshold. The cost is `hashes` mixes per shingle: of the order
// of ten seconds over twenty thousand entries of two pages each, once per dataset, against the
// hours the compaction of them takes.
export function groupDuplicates(entries, { threshold = 0.8, shingle = 5, hashes = 64, bands = 16 } = {}) {
  checkOptions({ threshold, shingle, hashes, bands })
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TypeError('groupDuplicates: entry ids must be distinct')
  const { find, unite } = unionFind(entries.length)
  const sets = exactPass(entries, shingle, unite)
  nearPass({ sets, threshold, hashes, bands, find, unite })

  const groups = new Map()
  for (const [i, entry] of entries.entries()) {
    const root = find(i)
    if (root === i) continue
    const ids = groups.get(entries[root].id) ?? []
    ids.push(entry.id)
    groups.set(entries[root].id, ids)
  }
  return groups
}

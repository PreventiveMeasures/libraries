import { hashSeed, random } from './random.js'

// Near-duplicate entries, grouped by text alone before anything is compacted, as each copy would be paid
// for and take a seat on every page: word shingles, MinHash signatures and banded LSH choose which pairs
// to compare by exact Jaccard (Broder 1997; Leskovec et al., "Mining of Massive Datasets", ch. 3).

// Case and punctuation folded away: a copy that differs by a comma is a copy
export const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const FNV_OFFSET = 0x811C9DC5
const FNV_PRIME = 0x01000193

// The sorted distinct 32-bit hashes of each run of `k` words, hashed over the words' own hashes; a text
// under `k` words is one shingle. A typed array, as sixteen million shingles fit in four bytes each where
// a Set each would not, and two sorted sets' Jaccard is one merge pass.
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
  return hashed.filter((h, i) => i === 0 || h !== hashed[i - 1])
}

// |A and B| / |A or B| over two sorted distinct arrays; two empty sets count as identical
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

// murmur3's finaliser, one hash function per salt: cheaper than (a*x + b) mod p without 64-bit integers,
// and as good for taking a minimum over a set
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

// The least value of each hash function over the set: two signatures agree in a position with the
// probability of their sets' Jaccard similarity
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

// Disjoint sets whose root is the least index, so a group's canonical entry is its first in input order
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

// Exact copies, by a hash of the folded text, which is compared again on a match, as twenty thousand
// texts stand a real chance of a collision. Returns the distinct texts' shingle sets, by index.
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

// The groups a bucket keeps to compare against: a templated dataset can land thousands of entries in one,
// and comparing all would be the quadratic pass hashing avoids. A copy still meets its original in
// another band they share.
const REPRESENTATIVES = 8

// Each distinct text compared by exact Jaccard with the groups in its buckets, and united with the first
// at the threshold
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
      const twin = held.find((j) => find(j) === find(i) || jaccard(sets.get(j), set) >= threshold)
      if (twin === undefined) {
        if (held.length < REPRESENTATIVES) held.push(i)
      } else {
        unite(twin, i)
      }
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

// A Map from each group's first id in input order to its copies' ids. At five-word shingles one word in
// a hundred changed leaves 0.9 against the 0.8 threshold; a pair at similarity s shares a bucket with
// probability 1 - (1 - s^4)^16 under the defaults: all but certain at 0.8, one in sixteen at 0.3.
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

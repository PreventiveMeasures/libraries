// Deterministic shuffling and paging. The search interlaces its rounds by re-shuffling the rows, and
// the shuffle has to be reproducible for two reasons: a re-run must render byte-identical pages, so
// every page call reads the disk cache instead of paying again; and in the first stage the page is
// the prompt-cache PREFIX shared across requests, which only works if every request renders the
// same pages. Math.random would give neither, so the seed is derived from the rows themselves.

// FNV-1a over the UTF-16 code units, 32-bit. Not cryptographic and not meant to be: it spreads
// similar inputs over the seed space, which is all a shuffle seed needs.
export function hashSeed(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// mulberry32: a small generator with a full 2^32 period, good enough to shuffle a few thousand rows
// and tiny enough to carry here rather than depend on.
export function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates over a copy; the input is never reordered in place.
export function shuffle(items, rng) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

// Consecutive pages of at most `size` items, and -- when `weigh` is given -- of at most `maxWeight`
// by that measure, so a page of full entries is bounded by characters where a page of summaries is
// bounded by count. An item heavier than the whole budget still gets a page of its own rather than
// being dropped: it is the caller's data, and a page call that is too long fails loudly where a
// silently skipped entry never would.
export function paginate(items, { size = Infinity, maxWeight = Infinity, weigh = () => 0 } = {}) {
  const pages = []
  let page = []
  let weight = 0
  for (const item of items) {
    const itemWeight = weigh(item)
    if (page.length > 0 && (page.length >= size || weight + itemWeight > maxWeight)) {
      pages.push(page)
      page = []
      weight = 0
    }
    page.push(item)
    weight += itemWeight
  }
  if (page.length > 0) pages.push(page)
  return pages
}

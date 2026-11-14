// Shuffles seeded from the rows, never Math.random: a re-run renders byte-identical pages, so every page
// reads the disk cache, and the first stage's pages are a prompt-cache prefix every request shares.

// FNV-1a, 32-bit: it spreads similar inputs over the seed space, which is all a seed needs
export function hashSeed(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.codePointAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// mulberry32, a full 2^32 period
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

// Pages of at most `size` items and `maxWeight` by `weigh`. An item heavier than the budget gets a page
// of its own rather than being dropped: a page too long fails loudly, where a skipped entry never would.
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

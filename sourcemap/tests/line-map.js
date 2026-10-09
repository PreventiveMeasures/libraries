// A map made by hand for a test: each generated line given whole to one
// file, so a case can be written as code, one line a file.

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function vlq(n) {
  let value = n < 0 ? (-n * 2) + 1 : n * 2
  let out = ''
  do {
    let digit = value % 32
    value = Math.floor(value / 32)
    if (value > 0) digit += 32
    out += DIGITS[digit]
  } while (value > 0)
  return out
}

// `owners[i]`: the index into `sources` that line i came from, or null for
// a line the map says nothing about.
export function lineMap(sources, owners, extra = {}) {
  let source = 0
  let line = 0
  const lines = owners.map((owner, i) => {
    if (owner === null) return ''
    const segment = vlq(0) + vlq(owner - source) + vlq(i - line) + vlq(0)
    source = owner
    line = i
    return segment
  })
  return { version: 3, sources, mappings: lines.join(';'), ...extra }
}

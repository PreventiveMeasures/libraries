// Byte helpers both halves use.

export const EMPTY = new Uint8Array(0)

export const isAscii = (raw) => raw.every((byte) => byte < 0x80)
export const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

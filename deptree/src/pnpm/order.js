// Two strings in the order of their UTF-8 bytes, as pnpm 12, in Rust,
// orders them: by code point, where pnpm 11's lexCompare goes by UTF-16
// unit.
const encoder = new TextEncoder()

export function byBytes(a, b) {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

// The Rust sanitize-filename crate, 0.6: sanitize_with_options, `windows`
// for the rules it keeps for Windows alone.

// Its control characters are C0 and C1, DEL not among them.
const ILLEGAL = /[/?<>\\:*|"]|[^\P{Cc}\u007F]/gu
const RESERVED = /^\.+$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu
// From where the run starts alone, as a scan from each dot would be quadratic.
const WINDOWS_TRAILING = /(?<![. ])[. ]+$/u

// At most 255 bytes of UTF-8: encodeInto stops before a character past them.
const encoder = new TextEncoder()
const BYTES = new Uint8Array(255)
const truncate = (name) => name.slice(0, encoder.encodeInto(name, BYTES).read)

export function sanitizeWithOptions(name, { windows, truncate: cut, replacement }) {
  if (typeof name !== 'string' || typeof replacement !== 'string') throw new TypeError('expected a string')
  let clean = name.replaceAll(ILLEGAL, () => replacement).replace(RESERVED, () => replacement)
  if (windows) clean = clean.replace(WINDOWS_RESERVED, () => replacement).replace(WINDOWS_TRAILING, () => replacement)
  return cut ? truncate(clean) : clean
}

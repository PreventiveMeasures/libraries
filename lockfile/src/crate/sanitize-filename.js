// The Rust sanitize-filename crate, 0.6: sanitize_with_options, `windows`
// for the rules it keeps for Windows alone.

// Its control characters are C0 and C1, DEL not among them.
const ILLEGAL = /[/?<>\\:*|"]|[^\P{Cc}\u007F]/gu
const RESERVED = /^\.+$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu
const WINDOWS_TRAILING = /[. ]+$/u

const encoder = new TextEncoder()

// At most 255 bytes of UTF-8, cut at a character.
function truncate(name) {
  let bytes = 0
  let end = 0
  for (const char of name) {
    bytes += encoder.encode(char).length
    if (bytes > 255) break
    end += char.length
  }
  return name.slice(0, end)
}

export function sanitizeWithOptions(name, { windows, truncate: cut, replacement }) {
  if (typeof name !== 'string' || typeof replacement !== 'string') throw new TypeError('expected a string')
  let clean = name.replaceAll(ILLEGAL, () => replacement).replace(RESERVED, () => replacement)
  if (windows) clean = clean.replace(WINDOWS_RESERVED, () => replacement).replace(WINDOWS_TRAILING, () => replacement)
  return cut ? truncate(clean) : clean
}

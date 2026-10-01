// The sanitize-filename crate, 0.6, as Soldeer names a dependency's folder:
// `-` for what a file name may not hold, and Windows's rules on Windows.

// Its control characters are C0 and C1, DEL not among them.
const ILLEGAL = /[/?<>\\:*|"]|[^\P{Cc}\u007F]/gu
const RESERVED = /^\.+$/u
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/iu
const WINDOWS_TRAILING = /[. ]+$/u

const encoder = new TextEncoder()

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

export function sanitize(name, windows) {
  let clean = name.replaceAll(ILLEGAL, '-').replace(RESERVED, '-')
  if (windows) clean = clean.replace(WINDOWS_RESERVED, '-').replace(WINDOWS_TRAILING, '-')
  return truncate(clean)
}

// The folder on Unix, and on Windows.
export const folders = (name) => [sanitize(name, false), sanitize(name, true)]

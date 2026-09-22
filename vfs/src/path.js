// Lexical helpers over path spellings. None of them consults a filesystem:
// `normalize` folds `.` and `..` by spelling alone, which is right for a
// declaration and wrong for a lookup, where a link on the way changes what
// `..` means — so a Vfs walks the spelling it is given and never calls it.

// UTF-8 byte order is code point order for well-formed text; the default
// sort compares UTF-16 units and misorders astral characters.
export function compareNames(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

export function normalize(path) {
  const absolute = path.startsWith('/')
  const out = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') out.push(part)
    else if (out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (!absolute) out.push('..')
  }
  if (absolute) return `/${out.join('/')}`
  return out.length === 0 ? '.' : out.join('/')
}

// `path` under `base` unless it is absolute already; nothing is folded, so
// the result is what a Vfs should be handed.
export const join = (base, path) => (path.startsWith('/') ? path : base.endsWith('/') ? base + path : `${base}/${path}`)

export function dirname(path) {
  const p = normalize(path)
  const i = p.lastIndexOf('/')
  return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i)
}

export function basename(path) {
  const p = normalize(path)
  return p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1)
}

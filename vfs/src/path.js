// POSIX paths as node:path.posix reads them — the same names, the same
// answers — without node. There is no working directory: `resolve` starts
// from `/`. Everything here is lexical; `normalize` and what builds on it
// fold `.` and `..` by spelling alone, which is right for a declaration and
// wrong for a lookup, where a link on the way changes what `..` means. A Vfs
// walks the spelling it is given and never calls them, so a caller with a
// working directory puts it in front (`${cwd}/${path}`) rather than folding
// the two together.

export const sep = '/'

const string = (value, name = 'path') => {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, not ${value === null ? 'null' : typeof value}`)
  return value
}

export const isAbsolute = (path) => string(path).startsWith('/')

// The non-empty components of a spelling; `.` and `..` are kept, since what
// they mean depends on who reads them.
export const segments = (path) => string(path).split('/').filter(Boolean)

export function normalize(path) {
  const absolute = isAbsolute(path)
  const out = []
  for (const part of segments(path)) {
    if (part === '.') continue
    if (part !== '..') out.push(part)
    else if (out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (!absolute) out.push('..')
  }
  let result = (absolute ? '/' : '') + out.join('/')
  if (result === '') result = '.'
  if (path.endsWith('/') && !result.endsWith('/')) result += '/'
  return result
}

export function join(...paths) {
  const parts = paths.filter((part) => string(part) !== '')
  return parts.length === 0 ? '.' : normalize(parts.join('/'))
}

// Right to left until a spelling is absolute, or `/` when none is. Every
// argument is checked, not only those read: a wrong one is a bug wherever
// it stands.
export function resolve(...paths) {
  for (const part of paths) string(part)
  const from = Math.max(paths.findLastIndex((part) => part.startsWith('/')), 0)
  const normalized = normalize(`/${paths.slice(from).join('/')}`)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

export function relative(from, to) {
  const source = segments(resolve(from))
  const target = segments(resolve(to))
  let shared = 0
  while (shared < source.length && shared < target.length && source[shared] === target[shared]) shared++
  return [...source.slice(shared).map(() => '..'), ...target.slice(shared)].join('/')
}

// The spelling without its trailing slashes, and where its last name starts.
function lastName(path) {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  return { end, start: path.lastIndexOf('/', end - 1) + 1 }
}

// `//` alone is kept, as POSIX leaves it to the implementation and node does.
export function dirname(path) {
  const { end, start } = lastName(string(path))
  if (end === 0) return path.length > 0 ? '/' : '.'
  if (start === 0) return '.'
  const parent = path.slice(0, start - 1)
  return parent === '' ? '/' : parent === '/' && path[1] === '/' ? '//' : parent
}

// With a suffix, the name less that suffix, unless the name is nothing but
// the suffix; a path that is exactly the suffix is nothing at all, as node
// has it.
export function basename(path, suffix) {
  if (suffix !== undefined && string(suffix, 'suffix') === string(path)) return ''
  const { end, start } = lastName(string(path))
  const name = path.slice(start, end)
  if (suffix === undefined || suffix === '' || name === suffix || !name.endsWith(suffix)) return name
  return name.slice(0, -suffix.length)
}

export function extname(path) {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || name === '..' ? '' : name.slice(dot)
}

// UTF-8 byte order is code point order for well-formed text; the default
// sort compares UTF-16 units and misorders astral characters.
export function compareNames(a, b) {
  const shared = Math.min(string(a).length, string(b).length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

// What renames by path pair files on, as triage's Compare pairs a bundle's,
// and a rename written as `git diff --stat` writes one.

// Extensions a file keeps its kind across (`a.js` -> `a.ts`, `a.css` -> `a.scss`).
const FAMILIES = new Map([
  ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].map((extension) => [extension, 'script']),
  ...['.css', '.scss', '.sass', '.less'].map((extension) => [extension, 'style']),
])

// The left items and the right ones each the other's only partner, by the keys
// each meets a partner on: none where a key holds two of a side, or a side's
// keys meet two of the other's.
export function onlyPartners(left, right) {
  const buckets = new Map()
  for (const [side, keyed] of [['left', left], ['right', right]]) {
    for (const [item, keys] of keyed) {
      for (const key of keys) {
        if (!buckets.has(key)) buckets.set(key, { left: [], right: [] })
        buckets.get(key)[side].push(item)
      }
    }
  }
  const partner = (keys, side) => {
    let found
    for (const key of keys) {
      const list = buckets.get(key)[side]
      if (list.length > 1 || (list.length === 1 && found !== undefined && found !== list[0])) return undefined
      if (list.length === 1) found = list[0]
    }
    return found
  }
  const pairs = []
  for (const [item, keys] of left) {
    const other = partner(keys, 'right')
    if (other !== undefined && partner(right.get(other), 'left') === item) pairs.push([item, other])
  }
  return pairs
}

// The keys a path meets a partner on: its name less the extension, the
// extension's family, and its directories as they are or with one open
// (`src/a.js` -> `lib/a.js`) past the last node_modules and its package's name.
export function renameKeys(path) {
  const dirs = path.split('/')
  const name = dirs.pop()
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  const head = [dot > 0 ? name.slice(0, dot) : name, FAMILIES.get(extension) ?? extension].join('\0')
  const modules = dirs.lastIndexOf('node_modules')
  const first = modules === -1 ? 0 : modules + (dirs[modules + 1]?.startsWith('@') ? 3 : 2)
  const keys = [`${head}\0${dirs.join('/')}`]
  for (let i = first; i < dirs.length; i++) keys.push(`${head}\0${i}\0${dirs.toSpliced(i, 1, '').join('/')}`)
  return keys
}

export function renameParts(from, to, { extension = true } = {}) {
  const a = from.split('/'), b = to.split('/')
  let head = 0
  while (head < a.length - 1 && head < b.length - 1 && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head - 1 && tail < b.length - head - 1 && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  const parts = {
    head: head ? `${a.slice(0, head).join('/')}/` : '',
    from: a.slice(head, a.length - tail).join('/'),
    to: b.slice(head, b.length - tail).join('/'),
    tail: tail ? `/${a.slice(-tail).join('/')}` : '',
  }
  const dot = parts.from.lastIndexOf('.')
  if (extension && !parts.from.includes('/') && !parts.to.includes('/') && dot > 0
      && parts.to.lastIndexOf('.') === dot && parts.from.slice(0, dot) === parts.to.slice(0, dot)) {
    return { ...parts, head: parts.head + parts.from.slice(0, dot), from: parts.from.slice(dot), to: parts.to.slice(dot) }
  }
  return parts
}

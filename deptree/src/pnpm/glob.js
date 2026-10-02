// glob 8 as npm-packlist 5 globs a `files` pattern for pnpm 9 and 10: dot
// and nocase, a leading `!` or `#` taken as it is. Each path found is spelled
// as glob spells it, a directory's with the trailing slash a pattern gave
// it, and a file named by a pattern with no part to match against names
// found alone where it is there.

import { GLOBSTAR, OBJECT_5, checkGlob, part5 } from './minimatch.js'

// npm-packlist globs `[object Object]` for a `browser` or `main` that is an
// object.
export function globParts(pattern, where) {
  if (pattern === '[object Object]') return [OBJECT_5]
  checkGlob(pattern, where)
  return pattern.split(/\/+/u).map(part5)
}

// `sets` are a pattern's sets of parts, or the pattern.
export function glob(view, sets, where) {
  const found = new Set()
  const run = (parts) => {
    let n = 0
    while (typeof parts[n] === 'string') n++
    if (n === parts.length) {
      const path = parts.join('/')
      const type = path === '' ? undefined : view.type(path)
      if (type === 'directory' || (type !== undefined && !path.endsWith('/'))) found.add(path)
      return
    }
    const prefix = n === 0 ? undefined : parts.slice(0, n).join('/')
    const remain = parts.slice(n)
    const entries = view.entries(prefix ?? '.')
    if (entries === undefined) return
    const under = (entry) => (prefix === undefined ? entry : `${prefix}/${entry}`)
    if (remain[0] === GLOBSTAR) {
      run([...prefix === undefined ? [] : [prefix], ...remain.slice(1)])
      for (const entry of entries) {
        run([under(entry), ...remain.slice(1)])
        run([under(entry), ...remain])
      }
      return
    }
    for (const entry of entries.filter((name) => remain[0].test(name))) {
      if (remain.length === 1) found.add(under(entry))
      else run([under(entry), ...remain.slice(1)])
    }
  }
  for (const parts of typeof sets === 'string' ? [globParts(sets, where)] : sets) run(parts)
  return found
}

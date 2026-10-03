// glob 8 as npm-packlist 5 globs a `files` pattern for pnpm 9 and 10: dot
// and nocase, a leading `!` or `#` taken as it is. Each path found is spelled
// as glob spells it, a directory's with the trailing slash a pattern gave
// it, and a file named by a pattern with no part to match against names
// found alone where it is there.

import { GLOBSTAR, OBJECT_5, checkGlob, checkLength, checkParts, readPart } from './minimatch.js'

// npm-packlist globs `[object Object]` for a `browser` or `main` that is an
// object.
function globParts(pattern, where) {
  if (pattern === '[object Object]') return [OBJECT_5]
  checkLength(pattern, where)
  checkGlob(pattern, where)
  const parts = pattern.split(/\/+/u)
  checkParts(pattern, parts, where)
  return parts.map((part) => readPart(part))
}

// `sets` are a pattern's sets of parts, or the pattern. glob walks one
// place of a pattern in one directory as often as `**` leads it there, and
// finds what it found before; each is walked once here, with no recursion.
export function glob(view, sets, where) {
  const found = new Set()
  const walked = new Set()
  const pending = []
  const all = typeof sets === 'string' ? [globParts(sets, where)] : sets
  const add = (prefix, set, at) => {
    const key = `${set}\0${at}\0${prefix === undefined ? '' : `/${prefix}`}`
    if (walked.has(key)) return
    walked.add(key)
    pending.push([prefix, set, at])
  }
  for (const set of all.keys()) add(undefined, set, 0)
  while (pending.length > 0) {
    const [given, set, start] = pending.pop()
    const parts = all[set]
    let at = start
    const strings = given === undefined ? [] : [given]
    while (typeof parts[at] === 'string') strings.push(parts[at++])
    if (at === parts.length) {
      const path = strings.join('/')
      const type = path === '' ? undefined : view.type(path)
      if (type === 'directory' || (type !== undefined && !path.endsWith('/'))) found.add(path)
      continue
    }
    const prefix = strings.length === 0 ? undefined : strings.join('/')
    const entries = view.entries(prefix ?? '.')
    if (entries === undefined) continue
    const under = (entry) => (prefix === undefined ? entry : `${prefix}/${entry}`)
    if (parts[at] === GLOBSTAR) {
      add(prefix, set, at + 1)
      for (const entry of entries) {
        add(under(entry), set, at + 1)
        add(under(entry), set, at)
      }
      continue
    }
    for (const entry of entries.filter((name) => parts[at].test(name))) {
      if (at + 1 === parts.length) found.add(under(entry))
      else add(under(entry), set, at + 1)
    }
  }
  return found
}

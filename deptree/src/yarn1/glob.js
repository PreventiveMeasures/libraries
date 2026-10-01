// The globs yarn matches with minimatch's defaults, as far as the lockfile
// reader lets them through: a segment at a time, `**` as any number of
// whole segments, `*` and `?` within one, and no segment that starts with
// a dot taken by a wildcard.

import { escape } from '../matcher.js'

const compiled = new Map()

function compile(glob) {
  return glob.split('/').map((segment) => {
    if (segment === '**') return null
    const dot = segment.startsWith('.') || !/[*?]/u.test(segment) ? '' : '(?!\\.)'
    return new RegExp(`^${dot}${segment.split(/([*?])/u).map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escape(part))).join('')}$`, 'u')
  })
}

// Whether `glob` takes `path`; positions in the glob a name at a time, a
// `**` taking none or more, in time linear in both.
export function matchesGlob(glob, path) {
  if (!compiled.has(glob)) compiled.set(glob, compile(glob))
  const tests = compiled.get(glob)
  const close = (places) => {
    for (let i = 0; i < tests.length; i++) if (places.has(i) && tests[i] === null) places.add(i + 1)
    return places
  }
  let places = close(new Set([0]))
  for (const segment of path.split('/')) {
    const next = new Set()
    for (const i of places) {
      if (i === tests.length) continue
      if (tests[i] === null) {
        if (!segment.startsWith('.')) next.add(i)
      } else if (tests[i].test(segment)) next.add(i + 1)
    }
    places = close(next)
  }
  return places.has(tests.length)
}

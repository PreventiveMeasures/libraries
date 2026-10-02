// The globs yarn matches with minimatch's defaults, as far as the lockfile
// reader lets them through: a segment at a time, `**` as any number of
// whole segments, `*` and `?` within one, and no segment that starts with
// a dot taken by a wildcard.

import { escape, reach } from '../matcher.js'

const compiled = new Map()

function compile(glob) {
  return glob.split('/').map((segment) => {
    if (segment === '**') return segment
    const dot = segment.startsWith('.') || !/[*?]/u.test(segment) ? '' : '(?!\\.)'
    return new RegExp(`^${dot}${segment.split(/([*?])/u).map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escape(part))).join('')}$`, 'u')
  })
}

// The places in `glob` that `path` reaches, as matcher.js's reach has
// them.
function placesOf(glob, path) {
  if (!compiled.has(glob)) compiled.set(glob, compile(glob))
  return reach(compiled.get(glob), path === '' ? [] : path.split('/'))
}

// Whether `glob` takes `path`.
export const matchesGlob = (glob, path) => placesOf(glob, path).at(-1)

// Whether `glob` may take a path below `dir`: some of it left to take.
export const reachesBelow = (glob, dir) => placesOf(glob, dir).slice(0, -1).some(Boolean)

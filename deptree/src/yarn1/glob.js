// The globs yarn matches with minimatch's defaults, as far as the lockfile
// reader lets them through: `**` takes whole segments, `*` and `?` stay
// within one, and no wildcard takes a leading dot.

import { escape, reach } from '../matcher.js'

const compiled = new Map()

function compile(glob) {
  return glob.split('/').map((segment) => {
    if (segment === '**') return segment
    const dot = segment.startsWith('.') || !/[*?]/u.test(segment) ? '' : '(?!\\.)'
    return new RegExp(`^${dot}${segment.split(/([*?])/u).map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escape(part))).join('')}$`, 'u')
  })
}

function placesOf(glob, path) {
  if (!compiled.has(glob)) compiled.set(glob, compile(glob))
  return reach(compiled.get(glob), path === '' ? [] : path.split('/'))
}

export const matchesGlob = (glob, path) => placesOf(glob, path).at(-1)

// Whether `glob` may take a path below `dir`: some of it left to take.
export const reachesBelow = (glob, dir) => placesOf(glob, dir).slice(0, -1).some(Boolean)

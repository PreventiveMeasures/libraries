// Workspace globs as yarn and npm match and walk them, by minimatch's
// defaults as far as the lockfile reader lets them through: no wildcard
// takes a leading dot.

import { DeptreeError, quote } from './error.js'
import { escape, reach } from './matcher.js'
import { typeOf } from './project.js'

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
const reachesBelow = (glob, dir) => placesOf(glob, dir).slice(0, -1).some(Boolean)

// The directories the globs take that have a package.json, as yarn and npm
// walk for them. glob follows a link or not by where it is, so one the
// globs reach is refused. `enter` refuses a directory, or says whether it
// is kept and walked into.
export function walkWorkspaces(project, globs, { manager, fold = (path) => path, skip = () => false, enter = () => true }) {
  const folded = globs.map(fold)
  const found = []
  const pending = globs.length === 0 ? [] : ['']
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const name of project.readdir(`/${dir}`)) {
      const path = dir === '' ? name : `${dir}/${name}`
      const key = fold(path)
      const taken = folded.some((glob) => matchesGlob(glob, key))
      if (skip(name) || (!taken && !folded.some((glob) => reachesBelow(glob, key)))) continue
      const { type } = project.lstat(`/${path}`)
      if (type === 'symlink') throw new DeptreeError(`a link where ${manager} looks for workspaces is not supported`, quote(path))
      if (type !== 'directory') continue
      const manifest = taken && typeOf(project, `/${path}/package.json`) !== undefined
      if (!enter(path, name, taken, manifest)) continue
      if (manifest) found.push(path)
      pending.push(path)
    }
  }
  return found.sort()
}

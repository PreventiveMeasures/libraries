// Name safety, applied before writing an entry and before handing one out
// of an archive. A name is a relative path: `.` segments and a directory's
// trailing slash are dropped, and what is left has no empty or `..`
// segment, no control character and no backslash — a separator on
// Windows, where `..\` would get past the check on `..`. A symlink target
// may use `..`, but is followed from where the link sits and refused if it
// climbs above the archive. Lengths are bounded by what a filesystem takes
// at all: PATH_MAX for the whole, NAME_MAX for a segment, in bytes.

import { TarError } from './error.js'
import { hasUnsafe, quote, utf8Length } from './text.js'

const PATH_MAX = 4096
const NAME_MAX = 255

function checkText(path, what) {
  if (typeof path !== 'string') throw new TarError(`${what} is not a string`)
  if (path === '') throw new TarError(`${what} is empty`)
  if (hasUnsafe(path, true)) throw new TarError(`${what} ${quote(path)} holds a control character or a backslash`)
  if (path.startsWith('/')) throw new TarError(`${what} ${quote(path)} is absolute`)
  if (utf8Length(path) > PATH_MAX) throw new TarError(`${what} ${quote(path)} is longer than ${PATH_MAX} bytes`)
  for (const segment of path.split('/')) {
    if (utf8Length(segment) > NAME_MAX) throw new TarError(`${what} ${quote(path)} has a segment longer than ${NAME_MAX} bytes`)
  }
}

// What is left of `.` or `./` is the archive root, which only a directory
// may name; it comes back as `.`.
export function cleanPath(path, what, directory = false) {
  checkText(path, what)
  const segments = path.split('/')
  if (segments.at(-1) === '') {
    if (!directory) throw new TarError(`${what} ${quote(path)} ends in a slash but is not a directory`)
    segments.pop()
  }
  const kept = segments.filter((segment) => segment !== '.')
  for (const segment of kept) {
    if (segment === '') throw new TarError(`${what} ${quote(path)} has an empty segment`)
    if (segment === '..') throw new TarError(`${what} ${quote(path)} has a .. segment`)
  }
  if (kept.length) return kept.join('/')
  if (!directory) throw new TarError(`${what} ${quote(path)} names the archive root but is not a directory`)
  return '.'
}

export function checkSymlinkTarget(name, target) {
  checkText(target, `symlink target of ${quote(name)}`)
  let depth = name.split('/').length - 1
  for (const segment of target.split('/')) {
    if (segment === '..') {
      if (--depth < 0) throw new TarError(`symlink ${quote(name)} points outside the archive, to ${quote(target)}`)
    } else if (segment !== '' && segment !== '.') {
      depth++
    }
  }
}

// Each name seen is an entry, a directory entry, or a directory implied by
// an entry inside it. An implied directory may still be admitted as one;
// anything else twice is a duplicate. An entry inside a non-directory is
// refused — that is the shape of a path through a symlink.
export class Names {
  #kinds = new Map()

  add(name, type, linkname) {
    if (type === 'link' && this.#kinds.get(linkname) !== 'entry') {
      throw new TarError(`hard link ${quote(name)} targets ${quote(linkname)}, which is not an earlier non-directory entry`)
    }
    const kind = type === 'directory' ? 'directory' : 'entry'
    const seen = this.#kinds.get(name)
    if (seen === 'directory' || seen === 'entry') throw new TarError(`duplicate entry ${quote(name)}`)
    if (seen === 'implied' && kind !== 'directory') throw new TarError(`${quote(name)} holds an earlier entry, so it cannot be a ${type}`)
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      const parent = name.slice(0, i)
      const above = this.#kinds.get(parent)
      if (above === 'entry') throw new TarError(`${quote(name)} is inside ${quote(parent)}, which is not a directory`)
      if (above === undefined) this.#kinds.set(parent, 'implied')
    }
    this.#kinds.set(name, kind)
  }
}

// The name and link target as cleaned, once admitted.
export function admit(names, path, type, target) {
  const name = cleanPath(path, 'entry name', type === 'directory')
  let linkname = target
  if (type === 'symlink') checkSymlinkTarget(name, target)
  else if (type === 'link') linkname = cleanPath(target, `hard link target of ${quote(name)}`)
  names.add(name, type, linkname)
  return { name, linkname }
}

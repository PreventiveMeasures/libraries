// Name safety, applied before writing an entry and before handing one out
// of an archive. A name is a relative path: `.` segments and a directory's
// trailing slash are dropped, and what is left has no empty or `..`
// segment, no control character and no backslash — a separator on
// Windows, where `..\` would get past the check on `..`. A symlink target
// may use `..`, but is followed from where the link sits and refused if it
// climbs above the archive. Lengths are bounded by what a filesystem takes
// at all: PATH_MAX for the whole, NAME_MAX for a segment, in bytes.
//
// A name may repeat only as the same entry again, field for field and byte
// for byte (some packagers write `d/f` and `d/./f` both): two different
// entries under one name would leave the winner to extraction order.
// Collisions a filesystem might add — case, Unicode normalisation — are
// the filesystem's, not the archive's, and are not looked for.

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

// The name and link target of an entry, cleaned and checked.
export function cleanNames(path, type, target) {
  const name = cleanPath(path, 'entry name', type === 'directory')
  let linkname = target
  if (type === 'symlink') checkSymlinkTarget(name, target)
  else if (type === 'link') linkname = cleanPath(target, `hard link target of ${quote(name)}`)
  return { name, linkname }
}

const FIELDS = ['type', 'mode', 'uid', 'gid', 'mtime', 'uname', 'gname', 'linkname', 'devmajor', 'devminor']
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

// Each name seen is an entry, a directory entry, or a directory implied by
// an entry inside it; an implied directory may still be named as one. An
// entry inside a non-directory is refused — that is the shape of a path
// through a symlink. Whether entries are kept with their data decides what
// a repeat can be compared with: the in-memory calls keep them, and a
// stream keeps the fields alone and refuses what it cannot compare.
export class Names {
  #seen = new Map()
  #keep

  constructor(keep = false) {
    this.#keep = keep
  }

  // `entry` is cleaned, with its data.
  add(entry) {
    const { name, type } = entry
    if (type === 'link' && this.#seen.get(entry.linkname)?.kind !== 'entry') {
      throw new TarError(`hard link ${quote(name)} targets ${quote(entry.linkname)}, which is not an earlier non-directory entry`)
    }
    const seen = this.#seen.get(name)
    if (seen !== undefined && seen.kind !== 'implied') {
      const differs = FIELDS.find((field) => seen.entry[field] !== entry[field])
      if (differs !== undefined) throw new TarError(`duplicate entry ${quote(name)} differs in ${differs}`)
      if (seen.entry.data === undefined) throw new TarError(`duplicate entry ${quote(name)}, which only the in-memory call can compare with the earlier one`)
      if (!sameBytes(seen.entry.data, entry.data)) throw new TarError(`duplicate entry ${quote(name)} differs in data`)
      return
    }
    const kind = type === 'directory' ? 'directory' : 'entry'
    if (seen !== undefined && kind !== 'directory') throw new TarError(`${quote(name)} holds an earlier entry, so it cannot be a ${type}`)
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
      const parent = name.slice(0, i)
      const above = this.#seen.get(parent)?.kind
      if (above === 'entry') throw new TarError(`${quote(name)} is inside ${quote(parent)}, which is not a directory`)
      if (above === undefined) this.#seen.set(parent, { kind: 'implied' })
    }
    this.#seen.set(name, { kind, entry: this.#keep ? entry : Object.fromEntries(FIELDS.map((field) => [field, entry[field]])) })
  }
}

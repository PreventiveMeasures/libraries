// Name safety, applied before writing an entry and before handing one out
// of an archive. A name is a relative path in clean segments (no leading
// slash, no empty, `.` or `..` segment), with no control character and no
// backslash — a separator on Windows, where `..\` would get past the check
// on `..`. Nothing is normalised: `./a` is refused, not read as `a`. A
// symlink may use `..`, but is followed from where it sits and refused if
// it climbs above the archive.

import { TarError } from './error.js'

const quote = (text) => JSON.stringify(text)

// C0 or DEL, and a backslash if asked.
export function hasUnsafe(text, backslash) {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f || (backslash && code === 0x5c)) return true
  }
  return false
}

function checkText(path, what) {
  if (typeof path !== 'string') throw new TarError(`${what} is not a string`)
  if (path === '') throw new TarError(`${what} is empty`)
  if (hasUnsafe(path, true)) throw new TarError(`${what} ${quote(path)} holds a control character or a backslash`)
  if (path.startsWith('/')) throw new TarError(`${what} ${quote(path)} is absolute`)
}

export function checkPath(path, what) {
  checkText(path, what)
  for (const segment of path.split('/')) {
    if (segment === '') throw new TarError(`${what} ${quote(path)} has an empty segment`)
    if (segment === '.' || segment === '..') throw new TarError(`${what} ${quote(path)} has a ${segment} segment`)
  }
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

export function admit(names, name, type, linkname) {
  checkPath(name, 'entry name')
  if (type === 'symlink') checkSymlinkTarget(name, linkname)
  else if (type === 'link') checkPath(linkname, `hard link target of ${quote(name)}`)
  names.add(name, type, linkname)
}

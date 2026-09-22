// What a name is allowed to be, and the record of the names seen so far.
// Both directions go through here: an entry is admitted before it is
// written, and before it is handed out of an archive being read, under one
// set of rules — what is refused on the way in would be refused on the way
// out, so nothing this package writes is something it would not read.
//
// A name is a relative path in clean segments: no leading slash, no empty
// segment, no `.` and no `..`, so that it names one place under whatever
// directory the archive is unpacked into and cannot reach above it. No
// control character, no backslash — a separator on Windows, which is where
// `..\` would otherwise slip past the check on `..`. Nothing here is
// normalised: `./a` is refused rather than read as `a`, because reading it
// as something else is how two names that should be one duplicate end up
// admitted as two.
//
// A symlink's target is a path of its own, and `..` in it is ordinary — a
// link to a sibling directory goes through one — but it is followed from
// where the link sits, and if it ever climbs above the archive it is
// refused: that is a link to somewhere on the machine that unpacks it,
// which no archive has business naming. A hard link names an earlier entry,
// so it is held to the rules a name is, and then to that.

import { TarError } from './error.js'

const quote = (text) => JSON.stringify(text)

// A control character (C0 or DEL) or a backslash, anywhere in the text.
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

// Followed from the link's own directory: each `..` goes up one, and going
// up from the top of the archive is out.
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

// Every name admitted so far, and what each is: an entry of its own, a
// directory entry, or a directory that exists only because something was
// admitted inside it. A name may be admitted once; a directory that was
// only implied may still be admitted as the directory it is. An entry
// inside something that is not a directory is refused — that is what a
// symlink followed by a path through it looks like, and the standard way
// an unpacker is walked out of its directory.
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

// The whole check, in the order that makes the messages right: the name
// itself, then the target if there is one, then the name against the rest.
export function admit(names, name, type, linkname) {
  checkPath(name, 'entry name')
  if (type === 'symlink') checkSymlinkTarget(name, linkname)
  else if (type === 'link') checkPath(linkname, `hard link target of ${quote(name)}`)
  names.add(name, type, linkname)
}

// Name safety, applied before writing an entry and before handing one out
// of an archive. A name is a relative path: `.` segments and a directory's
// trailing slash are dropped, and what is left has no empty or `..`
// segment, no control character and no backslash — a separator on
// Windows, where `..\` would get past the check on `..` — and does not
// start with a drive letter and colon, which Windows resolves from that
// drive rather than from the archive. A symlink target may use `..`, but
// is followed from where the link sits and refused if it climbs above the
// archive or passes through anything but a directory, which is how a
// chain of links would climb. A hard link to a symlink, directly or down a
// chain of hard links, is a second name for it, and is held to the same walk
// from where that name sits, since a target safe under `a/b/` need not be
// safe at the root. Lengths are bounded by what a filesystem takes at all:
// PATH_MAX for the whole as the archive stores it, a directory's slash
// counted, and NAME_MAX for a segment, in bytes.
//
// A name may repeat only as the same entry again, field for field and byte
// for byte (some npm packagers write `d/f` and `d/./f` both): two different
// entries under one name would leave the winner to extraction order.
// Collisions a filesystem might add — case, Unicode normalisation — are
// the filesystem's, not the archive's, and are not looked for.

import { sameBytes } from './bytes.js'
import { ArchiveError } from './error.js'
import { checkString, hasUnsafe, quote, utf8Length } from './text.js'

const PATH_MAX = 4096
const NAME_MAX = 255

// The rules every path is held to, whatever it names; hands back its
// segments, split the once.
function checkText(path, what) {
  checkString(path, what)
  if (path === '') throw new ArchiveError(`${what} is empty`)
  if (hasUnsafe(path, true)) throw new ArchiveError(`${what} ${quote(path)} holds a control or formatting character, or a backslash`)
  if (path.startsWith('/')) throw new ArchiveError(`${what} ${quote(path)} is absolute`)
  const segments = path.split('/')
  // Once `.` segments are dropped, `./C:x` is `C:x`, so the first segment
  // that is not one is what a drive letter is looked for on.
  if (/^[a-zA-Z]:/u.test(segments.find((segment) => segment !== '.') ?? '')) throw new ArchiveError(`${what} ${quote(path)} starts with a drive letter`)
  if (utf8Length(path) > PATH_MAX) throw new ArchiveError(`${what} ${quote(path)} is longer than ${PATH_MAX} bytes`)
  for (const segment of segments) {
    if (utf8Length(segment) > NAME_MAX) throw new ArchiveError(`${what} ${quote(path)} has a segment longer than ${NAME_MAX} bytes`)
  }
  return segments
}

// What is left of `.` or `./` is the archive root, which only a directory
// may name; it comes back as `.`. A path with nothing to drop comes back as
// the very string it came in as, so the name an archive stores and the one
// cleaned out of it are one string where they are one path.
export function cleanPath(path, what, directory = false) {
  const segments = checkText(path, what)
  const slash = segments.at(-1) === ''
  if (slash) {
    if (!directory) throw new ArchiveError(`${what} ${quote(path)} ends in a slash but is not a directory`)
    segments.pop()
  }
  const kept = segments.filter((segment) => segment !== '.')
  for (const segment of kept) {
    if (segment === '') throw new ArchiveError(`${what} ${quote(path)} has an empty segment`)
    if (segment === '..') throw new ArchiveError(`${what} ${quote(path)} has a .. segment`)
  }
  if (kept.length === 0) {
    if (!directory) throw new ArchiveError(`${what} ${quote(path)} names the archive root but is not a directory`)
    return '.'
  }
  const name = slash || kept.length < segments.length ? kept.join('/') : path
  // As the archive stores it, a directory's name carries its slash: what
  // pack takes, unpack then reads.
  if (utf8Length(name) + (directory ? 1 : 0) > PATH_MAX) throw new ArchiveError(`${what} ${quote(path)} is longer than ${PATH_MAX} bytes`)
  return name
}

// Checks the target, walked from the link's directory, never climbs above
// the archive, and returns its steps: each segment it goes into, or `..` to
// come back out of one. The walk is counted rather than spelled out, since
// spelling out the path at every step of a deep one costs its depth squared.
export function checkSymlinkTarget(name, target) {
  const steps = checkText(target, `symlink target of ${quote(name)}`).filter((segment) => segment !== '' && segment !== '.')
  let depth = name.split('/').length - 1
  for (const step of steps) {
    depth += step === '..' ? -1 : 1
    if (depth < 0) throw new ArchiveError(`symlink ${quote(name)} points outside the archive, to ${quote(target)}`)
  }
  return steps
}

// The name and link target of an entry, cleaned and checked.
export function cleanNames(path, type, target) {
  const name = cleanPath(path, 'entry name', type === 'directory')
  let linkname = target
  if (type === 'symlink') checkSymlinkTarget(name, target)
  else if (type === 'hardlink') linkname = cleanPath(target, `hard link target of ${quote(name)}`)
  return { name, linkname }
}

const node = () => ({ kind: undefined, entry: undefined, symlink: undefined, first: undefined, firstNode: undefined, rest: undefined })

// A node's first child sits on the node itself, and only a second one
// brings a map for the rest: a deep path is a chain of directories holding
// one thing each, and a map at every link of it would cost more than the
// link. With `make` false, a missing child stays missing.
function child(parent, segment, make = true) {
  if (parent.first === segment) return parent.firstNode
  let next = parent.rest?.get(segment)
  if (next !== undefined || !make) return next
  next = node()
  if (parent.first === undefined) {
    parent.first = segment
    parent.firstNode = next
  } else {
    parent.rest ??= new Map()
    parent.rest.set(segment, next)
  }
  return next
}

const FIELDS = ['type', 'mode', 'uid', 'gid', 'mtime', 'uname', 'gname', 'linkname', 'devmajor', 'devminor']

// Each name seen is an entry, a directory entry, or a directory implied by
// an entry inside it or by a symlink target walking through it; an implied
// directory may still be named as one. An entry inside a non-directory is
// refused — that is the shape of a path through a symlink — and so is a
// symlink target that walks through one, in either order, so no chain of
// links leads out of the archive. Whether entries are kept with their data
// decides what a repeat can be compared with: the in-memory calls keep
// them, and a stream keeps the fields alone and refuses what it cannot
// compare.
//
// The names are a tree walked a segment at a time, so a lookup hashes one
// segment rather than a whole path, and a walk down a deep one costs its
// length rather than its depth squared; a path is spelled out only for a
// refusal. A node's `kind` is unset until its path is seen, which makes the
// tree hold exactly what a map from each path seen to its kind would.
export class Names {
  #root = node()
  #keep

  constructor(keep = false) {
    this.#keep = keep
  }

  // `entry` is cleaned, with its data.
  add(entry) {
    const { name, type } = entry
    // The target of the symlink this entry is, if it is one: a symlink's
    // own, or, for a hard link, that of the entry it links to.
    let symlink = type === 'symlink' ? entry.linkname : undefined
    if (type === 'hardlink') {
      const target = this.#find(entry.linkname)
      if (target?.kind !== 'entry') throw new ArchiveError(`hard link ${quote(name)} targets ${quote(entry.linkname)}, which is not an earlier non-directory entry`)
      // A hard link to a symlink is a second name for that symlink, and a
      // relative target is followed from wherever it is reached: `../x` under
      // `a/b/` stays inside, the same link at the root does not. So the
      // target is walked again from here, as if the symlink sat at this name.
      // A hard link to such a hard link is the same symlink again, so the
      // target travels down a chain of them, rather than the chain being
      // followed back, which would cost each new link the chain's length.
      symlink = target.symlink
      if (symlink !== undefined) this.#symlink(name, symlink, `hard link ${quote(name)} to symlink ${quote(entry.linkname)}`)
    }
    const segments = name.split('/')
    const nodes = this.#walk(segments)
    const seen = nodes.at(-1)
    if (seen.kind !== undefined && seen.kind !== 'implied') {
      const differs = FIELDS.find((field) => seen.entry[field] !== entry[field])
      if (differs !== undefined) throw new ArchiveError(`duplicate entry ${quote(name)} differs in ${differs}`)
      if (seen.entry.data === undefined) throw new ArchiveError(`duplicate entry ${quote(name)}, which only the in-memory call can compare with the earlier one`)
      if (!sameBytes(seen.entry.data, entry.data)) throw new ArchiveError(`duplicate entry ${quote(name)} differs in data`)
      return
    }
    const kind = type === 'directory' ? 'directory' : 'entry'
    if (seen.kind !== undefined && kind !== 'directory') throw new ArchiveError(`${quote(name)} is already a directory, so it cannot be a ${type}`)
    // Every parent, the outermost first; nodes[0] is the root, which no
    // name has as a parent.
    for (let i = 1; i < segments.length; i++) {
      this.#directory(nodes[i], () => `${quote(name)} is inside ${quote(segments.slice(0, i).join('/'))}, which is not a directory`)
    }
    seen.kind = kind
    seen.symlink = symlink
    seen.entry = this.#keep ? entry : Object.fromEntries(FIELDS.map((field) => [field, entry[field]]))
    if (type === 'symlink') this.#symlink(name, entry.linkname, `symlink ${quote(name)}`)
  }

  // A target followed from `at`: it has to stay inside the archive, and every
  // path it walks through has to be a directory — each one it stands on short
  // of the last step, the archive root aside. `what` names it in a refusal.
  #symlink(at, target, what) {
    const steps = checkSymlinkTarget(at, target)
    const path = at.split('/').slice(0, -1)
    const nodes = this.#walk(path)
    for (const [i, step] of steps.entries()) {
      if (step === '..') {
        path.pop()
        nodes.pop()
      } else {
        path.push(step)
        nodes.push(child(nodes.at(-1), step))
      }
      if (i < steps.length - 1 && path.length) this.#directory(nodes.at(-1), () => `the target of ${what} passes through ${quote(path.join('/'))}, which is not a directory`)
    }
  }

  // A path is a directory if named or implied as one so far, or implied now.
  // `refusal` spells the path out, and only if it has to.
  #directory(at, refusal) {
    if (at.kind === 'entry') throw new ArchiveError(refusal())
    at.kind ??= 'implied'
  }

  // The root and the node of each segment in turn, made where missing: a
  // node made here is unseen until something sets its kind.
  #walk(segments) {
    const nodes = [this.#root]
    for (const segment of segments) nodes.push(child(nodes.at(-1), segment))
    return nodes
  }

  // A path's node where it has one, without making any.
  #find(path) {
    let at = this.#root
    for (const segment of path.split('/')) {
      at = child(at, segment, false)
      if (at === undefined) return undefined
    }
    return at
  }
}

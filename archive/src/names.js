import { sameBytes } from './bytes.js'
import { ArchiveError } from './error.js'
import { checkString, hasUnsafe, quote, tooLong } from './text.js'

const PATH_MAX = 4096 // bytes of the name as stored, a directory's slash counted
const NAME_MAX = 255 // bytes of a segment

// The rules for any path, a symlink target's too
function checkText(path, what) {
  checkString(path, what)
  if (path === '') throw new ArchiveError(`${what} is empty`)
  // A backslash is a separator on Windows, where `..\` would pass the `..` check
  if (hasUnsafe(path, true)) throw new ArchiveError(`${what} ${quote(path)} holds a control or formatting character, or a backslash`)
  if (path.startsWith('/')) throw new ArchiveError(`${what} ${quote(path)} is absolute`)
  const segments = path.split('/')
  // Windows resolves `C:x` from that drive, and `./C:x` is `C:x` once `.` is dropped
  if (/^[a-zA-Z]:/u.test(segments.find((segment) => segment !== '.') ?? '')) throw new ArchiveError(`${what} ${quote(path)} starts with a drive letter`)
  if (tooLong(path, PATH_MAX)) throw new ArchiveError(`${what} ${quote(path)} is longer than ${PATH_MAX} bytes`)
  if (segments.some((segment) => tooLong(segment, NAME_MAX))) throw new ArchiveError(`${what} ${quote(path)} has a segment longer than ${NAME_MAX} bytes`)
  return segments
}

// `.` segments and a directory's trailing slash dropped; only a directory may name the root, as `.`
export function cleanPath(path, what, directory = false) {
  const segments = checkText(path, what)
  if (segments.at(-1) === '') {
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
  const name = kept.join('/')
  if (tooLong(name, PATH_MAX - (directory ? 1 : 0))) throw new ArchiveError(`${what} ${quote(path)} is longer than ${PATH_MAX} bytes`)
  return name
}

export function levelsAbove(above = 0) {
  if (!(Number.isSafeInteger(above) && above >= 0)) throw new ArchiveError(`symlinksAbove ${String(above)} is not a whole number of levels`)
  return above
}

// The target's steps from the link's directory, each a segment or `..`, climbing at most `above` levels
// above the root. Counted rather than spelled out, which would cost a deep walk its depth squared.
export function checkSymlinkTarget(name, target, above = 0) {
  const steps = checkText(target, `symlink target of ${quote(name)}`).filter((segment) => segment !== '' && segment !== '.')
  let depth = name.split('/').length - 1
  for (const step of steps) {
    depth += step === '..' ? -1 : 1
    if (depth < -above) {
      const how = above === 0 ? 'outside the archive' : `more than ${above} level${above === 1 ? '' : 's'} above the archive`
      throw new ArchiveError(`symlink ${quote(name)} points ${how}, to ${quote(target)}`)
    }
  }
  return steps
}

// A symlink's target is checked, never rewritten; a hard link's is a name, cleaned as one
export function cleanNames(path, type, target, above = 0) {
  const name = cleanPath(path, 'entry name', type === 'directory')
  let linkname = target
  if (type === 'symlink') checkSymlinkTarget(name, target, above)
  else if (type === 'hardlink') linkname = cleanPath(target, `hard link target of ${quote(name)}`)
  return { name, linkname }
}

const node = () => ({ kind: undefined, entry: undefined, symlink: undefined, first: undefined, firstNode: undefined, rest: undefined })

// A node's first child sits on the node and only a second brings a Map: a deep path is a chain of
// directories holding one thing each, where a Map at every link would cost more than the link.
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

// Each path seen is an 'entry', a 'directory', or a directory 'implied' by a path or symlink target through it.
// Nothing may sit or be walked through inside a non-directory, so no chain of links leads out of the archive.
// A name repeats only as the same entry; `keep` keeps data to compare a repeat with, else it is refused.
export class Names {
  #root = node()
  #keep
  #above

  constructor(keep = false, symlinksAbove = 0) {
    this.#keep = keep
    this.#above = levelsAbove(symlinksAbove)
  }

  get above() {
    return this.#above
  }

  // `entry` is cleaned
  add(entry) {
    const { name, type } = entry
    let symlink = type === 'symlink' ? entry.linkname : undefined
    if (type === 'hardlink') {
      const target = this.#find(entry.linkname)
      if (target?.kind !== 'entry') throw new ArchiveError(`hard link ${quote(name)} targets ${quote(entry.linkname)}, which is not an earlier non-directory entry`)
      // A hard link to a symlink is that symlink again at this name, where its target is walked again
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
    for (let i = 1; i < segments.length; i++) {
      this.#directory(nodes[i], () => `${quote(name)} is inside ${quote(segments.slice(0, i).join('/'))}, which is not a directory`)
    }
    seen.kind = kind
    seen.symlink = symlink
    seen.entry = this.#keep ? entry : Object.fromEntries(FIELDS.map((field) => [field, entry[field]]))
    if (type === 'symlink') this.#symlink(name, entry.linkname, `symlink ${quote(name)}`)
  }

  // Every path the target stands on inside the archive short of its last step has to be a directory.
  // Past the root nothing it passes is the archive's.
  #symlink(at, target, what) {
    const steps = checkSymlinkTarget(at, target, this.#above)
    const path = at.split('/').slice(0, -1)
    const nodes = this.#walk(path)
    for (const [i, step] of steps.entries()) {
      if (step === '..') {
        if (path.length === 0) return
        path.pop()
        nodes.pop()
      } else {
        path.push(step)
        nodes.push(child(nodes.at(-1), step))
      }
      if (i < steps.length - 1 && path.length) this.#directory(nodes.at(-1), () => `the target of ${what} passes through ${quote(path.join('/'))}, which is not a directory`)
    }
  }

  // `refusal` spells the path out only when it has to
  #directory(at, refusal) {
    if (at.kind === 'entry') throw new ArchiveError(refusal())
    at.kind ??= 'implied'
  }

  #walk(segments) {
    const nodes = [this.#root]
    for (const segment of segments) nodes.push(child(nodes.at(-1), segment))
    return nodes
  }

  #find(path) {
    let at = this.#root
    for (const segment of path.split('/')) {
      at = child(at, segment, false)
      if (at === undefined) return undefined
    }
    return at
  }
}

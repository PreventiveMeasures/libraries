// Hand-written against vfs.js; a change to either belongs with the other.

export type NodeType = 'file' | 'directory' | 'symlink'

// `ino` identifies the inode: two names of one hard-linked file share it.
// `mtime` is whole seconds since the epoch, as tar stores it, and changes
// only when set. `size` is a file's byte length, a link's target length in
// bytes, and 0 for a directory.
export interface Stat {
  type: NodeType
  ino: number
  mode: number
  mtime: number
  size: number
}

export interface WalkEntry {
  path: string
  type: NodeType
  depth: number
}

// The tar package's entry shape, as far as a Vfs holds it: `link` is a hard
// link to an earlier entry, `linkname` the target of a link of either kind,
// `data` the bytes of a file and empty otherwise.
export interface Entry {
  name: string
  type: NodeType | 'link'
  mode: number
  mtime: number
  linkname: string
  data: Uint8Array
}

// What vfsFromEntries takes: tar's own entries, or the same with the
// optional fields left out. `contiguous-file` is a file. A name follows
// tar's rules: relative, with no empty or `..` segment, no control, line
// separator or bidirectional character, no backslash, no drive letter in
// front, at most 4096 bytes as spelled and as stored (a directory's
// trailing slash counted),
// and a trailing slash on a directory alone; it may repeat
// only as the same entry again. A hard link's mode and mtime, if given,
// are its target's. `data` is a file's and `linkname` a link's: either
// given on another type is refused, not dropped. A mode or mtime given is
// checked as given, on a repeat and a hard link too: null is not left out.
export interface EntryInput {
  name: string
  type?: NodeType | 'link' | 'contiguous-file'
  data?: string | Uint8Array
  mode?: number
  mtime?: number
  linkname?: string
}

// A source tree as a flat map: a path to what is there, spelled from `/` or
// relative to it, by the rules of an entry name otherwise. Text and bytes are
// files; an object says what else, `target` being a symlink's target, kept
// as spelled, or the path a hard link names, spelled as a key is. Parent
// directories are implied.
export type Source =
  | string
  | Uint8Array
  | { type: 'file'; data?: string | Uint8Array; mode?: number; mtime?: number }
  | { type: 'directory'; mode?: number; mtime?: number }
  | { type: 'symlink'; target: string; mode?: number; mtime?: number }
  | { type: 'link'; target: string }
export type Sources = Record<string, Source> | Map<string, Source>

export function createVfs(sources?: Sources): Vfs
export function vfsFromEntries(entries: Iterable<EntryInput>): Vfs

// Paths resolve from `/`, component by component, following links as the
// kernel does; a relative path is one under `/`, and nothing is folded by
// spelling. Every method throws a VfsError with the POSIX code for what
// went wrong, and a TypeError or RangeError for an argument of the wrong
// type or range. Bytes returned are the file's own and must not be written
// into; bytes given are copied.
export class Vfs {
  constructor()
  stat(path: string): Stat
  lstat(path: string): Stat
  isFile(path: string): boolean
  isDirectory(path: string): boolean
  isSymlink(path: string): boolean
  realpath(path: string): string
  readFile(path: string): Uint8Array
  readText(path: string): string
  readlink(path: string): string
  readdir(path: string): string[]
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; mtime?: number }): void
  appendFile(path: string, data: string | Uint8Array): void
  mkdir(path: string, options?: { recursive?: boolean; mode?: number; mtime?: number }): void
  // A link's mode is 0o777 unless given; chmod follows the link, so it is
  // set here or not at all. The target is at most 4096 bytes of UTF-8, as
  // a filesystem and an archive hold it, or ENAMETOOLONG.
  symlink(target: string, path: string, options?: { mode?: number; mtime?: number }): void
  // A link at `existing` is linked itself, unless a trailing slash follows
  // it, as lstat's does; a directory is EPERM once `path` is found free.
  link(existing: string, path: string): void
  unlink(path: string): void
  rmdir(path: string): void
  rm(path: string, options?: { recursive?: boolean }): void
  rename(from: string, to: string): void
  chmod(path: string, mode: number): void
  utimes(path: string, mtime: number): void
  // Depth first from what `path` leads to, siblings in code point order,
  // links named but not crossed. `path` is resolved when this is called, so
  // a wrong one throws here rather than on the first step.
  walk(path?: string): Generator<WalkEntry, void, undefined>
  // The same tree as tar entries, names relative to `path` and `.` for it
  // (a file's own name if it is one), an inode's second name a hard link to
  // its first. Resolved when called, as walk is.
  entries(path?: string): Generator<Entry, void, undefined>
}

// `message` is the line a shell prints, the path in it with any control,
// line separator or bidirectional control escaped; `path` is as given.
export class VfsError extends Error {
  constructor(code: string, path: string)
  code: string
  path: string
}

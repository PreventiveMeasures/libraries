// Hand-written against index.js; a change to either belongs with the other.

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
// optional fields left out. `contiguous-file` is a file.
export interface EntryInput {
  name: string
  type?: NodeType | 'link' | 'contiguous-file'
  data?: string | Uint8Array
  mode?: number
  mtime?: number
  linkname?: string
}

// A source tree as a flat map: a path to what is there. Text and bytes are
// files; an object says what else, `target` being a symlink's target or the
// path a hard link names. Parent directories are implied.
export type Source =
  | string
  | Uint8Array
  | { type: 'file'; data?: string | Uint8Array; mode?: number; mtime?: number }
  | { type: 'directory'; mode?: number; mtime?: number }
  | { type: 'symlink'; target: string; mtime?: number }
  | { type: 'link'; target: string }
export type Sources = Record<string, Source> | Map<string, Source>

export function createVfs(sources?: Sources): Vfs
export function vfsFromEntries(entries: Iterable<EntryInput>): Vfs

// Paths resolve from `/`, component by component, following links as the
// kernel does; a relative path is one under `/`. Every method throws a
// VfsError with the POSIX code for what went wrong. Bytes returned are the
// file's own and must not be written into; bytes given are copied.
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
  symlink(target: string, path: string, options?: { mtime?: number }): void
  link(existing: string, path: string): void
  unlink(path: string): void
  rmdir(path: string): void
  rm(path: string, options?: { recursive?: boolean }): void
  rename(from: string, to: string): void
  chmod(path: string, mode: number): void
  utimes(path: string, mtime: number): void
  // Depth first from `path`, siblings in code point order, links named but
  // not crossed.
  walk(path?: string): Generator<WalkEntry, void, undefined>
  // The same tree as tar entries, names relative to `path` and `.` for it.
  entries(path?: string): Generator<Entry, void, undefined>
}

export class VfsError extends Error {
  constructor(code: string, path: string)
  code: string
  path: string
}

// Lexical helpers: none consults a filesystem. `join` folds nothing, so
// what it returns still resolves through links correctly.
export function normalize(path: string): string
export function join(base: string, path: string): string
export function dirname(path: string): string
export function basename(path: string): string
export function compareNames(a: string, b: string): number

// The typed contract for tar/index.js, hand-written: keep it name for name
// with index.js, and change it in the same commit as the signature.

// tar's entry types under tar-stream's names. A 'link' is a hard link to
// an earlier entry; a 'contiguous-file' is a file for every purpose here.
export type EntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'link'
  | 'fifo'
  | 'character-device'
  | 'block-device'
  | 'contiguous-file'

// An entry read out of an archive. `name` is a relative path with `.`
// segments and a directory's trailing slash dropped, or `.` for the
// archive root itself, which only a directory names; `mtime` is whole
// seconds since the epoch; `linkname` is '' and the device numbers 0
// where they do not apply; `data` is empty for anything but a file, and
// a view over the archive bytes where they arrived in one piece.
export interface Entry {
  name: string
  type: EntryType
  mode: number
  uid: number
  gid: number
  mtime: number
  uname: string
  gname: string
  linkname: string
  devmajor: number
  devminor: number
  data: Uint8Array
}

// An entry to write. `name` is cleaned as above, so `./a`, `a/./b` and
// `dir/` are taken; only a directory may end in a slash or name the root.
// `type` defaults to 'file'; `mode` to 0o644, 0o755 for a directory, 0o777
// for a symlink; owners to 0 with empty names; `mtime` to 0. `linkname` is
// the target of a symlink or hard link.
export interface EntryInput {
  name: string
  type?: EntryType
  data?: Uint8Array
  mode?: number
  uid?: number
  gid?: number
  mtime?: number
  uname?: string
  gname?: string
  linkname?: string
  devmajor?: number
  devminor?: number
}

// GNU tar's names: 'gnu' is what plain `tar` writes and the default here,
// 'ustar' refuses what it cannot hold, 'pax' holds everything.
export type Format = 'gnu' | 'ustar' | 'pax'

// `blocking` is tar's -b: zero padding to a multiple of that many 512-byte
// blocks, 20 by default; 1 pads nothing past the two zero end blocks.
export interface PackOptions {
  format?: Format
  blocking?: number
}

// Both refuse a name that repeats as a different entry — anything but
// the same fields and the same bytes again — an entry inside something
// that is not a directory, and a hard link to no earlier entry.
export function pack(entries: Iterable<EntryInput>, options?: PackOptions): Uint8Array
export function unpack(bytes: Uint8Array): Entry[]

// The same a piece at a time, as plain generators. A stream keeps no
// entry's data, so a name that repeats with the same fields is refused
// there, and such an archive is for the in-memory call. packStream yields
// each entry's `data` as the very array it was given.
export function packStream(entries: Iterable<EntryInput>, options?: PackOptions): Generator<Uint8Array, void, undefined>
export function packStreamAsync(entries: Iterable<EntryInput> | AsyncIterable<EntryInput>, options?: PackOptions): AsyncGenerator<Uint8Array, void, undefined>
export function unpackStream(chunks: Iterable<Uint8Array>): Generator<Entry, void, undefined>
export function unpackStreamAsync(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<Entry, void, undefined>

// `offset` is where in the archive the reader gave up; unset from the writer.
export class TarError extends Error {
  constructor(detail: string, offset?: number)
  offset: number | undefined
}

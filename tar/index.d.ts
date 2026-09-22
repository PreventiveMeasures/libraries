// The typed contract for tar/index.js, hand-written because the package is
// plain JavaScript. One file rather than a .d.ts per module: index.js IS the
// surface, so the declarations below should read against it name for name,
// in the same order and under the same headings.
//
// Keep it honest. Nothing checks these against the implementation — a
// declaration that drifts is a silent lie to every caller that trusts it,
// so a change to an exported signature belongs in the same commit as the
// change here.

// The entry types tar has, under the names tar-stream gave them. A 'link'
// is a hard link to an earlier entry; a 'contiguous-file' is a file for
// every purpose here.
export type EntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'link'
  | 'fifo'
  | 'character-device'
  | 'block-device'
  | 'contiguous-file'

// An entry as read out of an archive: every field present. `name` is a
// clean relative path with no trailing slash, `type` saying what it is;
// `mtime` is whole seconds since the epoch; `linkname` is '' for anything
// but a link, and the device numbers 0 for anything but a device. `data`
// is empty for anything but a file, and where an archive arrived in one
// piece it is a view over those bytes, not a copy.
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

// An entry as given to be written: only the name is required. `type`
// defaults to 'file'; a directory's name may carry a trailing slash. `mode`
// defaults to 0o644, 0o755 for a directory, 0o777 for a symlink; owners to
// 0 with empty names; `mtime` to 0. `data` is for files only, and
// `linkname` — the target — is required for a symlink or a hard link.
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

// GNU tar's names for the formats it writes. 'gnu' is what plain `tar`
// writes and the default here; 'ustar' is POSIX 1988 and refuses what it
// cannot hold; 'pax' is POSIX 2001 and holds everything.
export type Format = 'gnu' | 'ustar' | 'pax'

// `blocking` is tar's -b: the archive is padded with zeros to a multiple of
// that many 512-byte blocks, 20 by default as in tar; 1 pads nothing past
// the two zero blocks that end every archive.
export interface PackOptions {
  format?: Format
  blocking?: number
}

// Entries in, the archive out.
export function pack(entries: Iterable<EntryInput>, options?: PackOptions): Uint8Array

// The archive in, its entries out, in order.
export function unpack(bytes: Uint8Array): Entry[]

// The same two a piece at a time, as plain generators. The chunks packStream
// yields include each entry's `data` as the very array it was given.
export function packStream(entries: Iterable<EntryInput>, options?: PackOptions): Generator<Uint8Array, void, undefined>
export function packStreamAsync(entries: Iterable<EntryInput> | AsyncIterable<EntryInput>, options?: PackOptions): AsyncGenerator<Uint8Array, void, undefined>
export function unpackStream(chunks: Iterable<Uint8Array>): Generator<Entry, void, undefined>
export function unpackStreamAsync(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<Entry, void, undefined>

// Thrown by either direction; `offset` counts bytes from the start of the
// archive being read, and is unset from the writer.
export class TarError extends Error {
  constructor(detail: string, offset?: number)
  offset: number | undefined
}

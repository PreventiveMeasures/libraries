// The typed contract for archive/tar.js, hand-written: keep it name for name
// with tar.js, and change it in the same commit as the signature.

// tar's entry types under tar-stream's names, but for a 'hardlink', which
// tar-stream calls a 'link': a hard link to an earlier entry. A
// 'contiguous-file' is a file for every purpose here.
export type EntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'hardlink'
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
//
// Beside those, what the archive itself says. `storedName` and
// `storedLinkname` are the name and link target as stored, before any
// cleaning -- `./a` where `name` is `a`, `dir/` where it is `dir`, a ustar
// prefix joined on -- and passed every check the cleaned ones did; only a
// hard link's target is ever cleaned, so a symlink's is its `linkname`.
// `pax` is the records of the entry's own pax header and `globalPax` those
// of the global header it is under, each in the order stored, those read
// into the fields above among them; the fields take an entry's own record
// over the global one. A Map is shared -- every entry under one global
// header has its, every entry without a header the one empty Map -- so it
// cannot be changed. A value this package does not read is as stored,
// unchecked, and may hold any character, a control one included.
// `extended` is the extended headers read since the entry before it, in
// the order stored, each its kind -- its own pax header, a global one,
// GNU's long name and long link -- and its magic; the one empty list where
// none was, and frozen, as a Map is. An extended header, a global one too,
// with no entry after it is refused. `magic` is the entry's own header's:
// POSIX's 'ustar', or 'gnu', under which the bytes ustar holds a name's
// prefix in are GNU's own and not read as one.
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
  storedName: string
  storedLinkname: string
  pax: ReadonlyMap<string, string>
  globalPax: ReadonlyMap<string, string>
  extended: readonly ExtendedHeader[]
  magic: 'ustar' | 'gnu'
}

// An extended header, as `extended` lists them.
export interface ExtendedHeader {
  kind: 'pax' | 'global' | 'longname' | 'longlink'
  magic: 'ustar' | 'gnu'
}

// An entry to write. `name` is cleaned as above, so `./a`, `a/./b` and
// `dir/` are taken; only a directory may end in a slash or name the root.
// `type` defaults to 'file'; `mode` to 0o644, 0o755 for a directory, 0o777
// for a symlink; owners to 0 with empty names; `mtime` to 0. `linkname` is
// the target of a symlink or hard link. An entry read out is one to write
// as it is; what it stored is not written again, only these fields.
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

// `symlinksAbove` lets a relative symlink target climb up to that many
// levels above the archive's root, none by default: for a directory
// archived on its own, as GitHub archives a tree, that links to the files
// of the tree it was cut from -- `LICENSE -> ../../LICENSE` in a tree's
// `packages/a/`, archived under one top directory, climbs one. Past the root
// the archive cannot tell where a target leads, not even back into itself
// by the name it is extracted under, so what it passes through there is
// the caller's to know. An absolute target is refused regardless, and what
// one call reads with it, another writes with it.
export interface SymlinkOptions {
  symlinksAbove?: number
}

// `blocking` is tar's -b: zero padding to a multiple of that many 512-byte
// blocks, 20 by default; 1 pads nothing past the two zero end blocks.
export interface PackOptions extends SymlinkOptions {
  format?: Format
  blocking?: number
}

// `maxEntries` bounds how many entries the archive may hold, every kind
// counted and a repeat again, its extended headers not: past it the call
// throws with `limited` set, at the header that crosses it, before that
// entry is read. No bound by default.
export interface UnpackOptions extends SymlinkOptions {
  maxEntries?: number
}

// Both refuse a name that repeats as a different entry -- anything but the
// same fields and the same bytes again, however either was stored -- an
// entry inside something that is not a directory, a symlink whose target
// climbs out of the archive, further than `symlinksAbove` lets it, or
// passes through anything in it but a directory, and a hard link to no
// earlier entry. A hard link to a symlink, directly or down a chain of hard
// links, is a second name for it, and its target is walked again from that
// name, which a target safe where the symlink sits need not survive.
export function pack(entries: Iterable<EntryInput>, options?: PackOptions): Uint8Array
export function unpack(bytes: Uint8Array, options?: UnpackOptions): Entry[]

// The same a piece at a time, as async generators over a plain or an
// async iterable. A stream keeps no entry's data, so a name that repeats
// with the same fields is refused there, and such an archive is for the
// in-memory call. packStream yields each entry's `data` as the very array
// it was given.
export function packStream(entries: Iterable<EntryInput> | AsyncIterable<EntryInput>, options?: PackOptions): AsyncGenerator<Uint8Array, void, undefined>
export function unpackStream(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, options?: UnpackOptions): AsyncGenerator<Entry, void, undefined>

// `offset` is where in the archive the reader gave up; unset from the writer.
// `limited` is true where a bound the caller set stopped it, rather than
// anything wrong with the archive.
export class ArchiveError extends Error {
  constructor(detail: string, offset?: number, options?: { limited?: boolean })
  offset: number | undefined
  limited: boolean
}

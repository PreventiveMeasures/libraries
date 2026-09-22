// The typed contract for archive/zip.js, hand-written: keep it name for name
// with zip.js, and change it in the same commit as the signature.

// A 'symlink' is stored the way Info-ZIP stores one: its target as the
// entry's data, its type in the Unix mode.
export type EntryType = 'file' | 'directory' | 'symlink'

// An entry read out of an archive. `name` is a relative path with `.`
// segments and a directory's trailing slash dropped, or `.` for the
// archive root itself, which only a directory names; `mode` is the Unix
// permission bits, or the usual default where the maker recorded none;
// `mtime` is whole seconds since the epoch, exact where the archive
// carries an extended timestamp and DOS time read as UTC otherwise;
// `linkname` is '' for anything but a symlink; `data` is empty for
// anything but a file, and a view over the archive bytes where the entry
// was stored.
export interface Entry {
  name: string
  type: EntryType
  mode: number
  mtime: number
  linkname: string
  data: Uint8Array
}

// An entry to write. `name` is cleaned as above, so `./a`, `a/./b` and
// `dir/` are taken; only a directory may end in a slash or name the root.
// `type` defaults to 'file'; `mode` to 0o644, 0o755 for a directory, 0o777
// for a symlink; `mtime` to 1980-01-01T00:00:00Z, the earliest DOS time,
// and must lie between that and 2038-01-19, which the exact timestamp
// holds. `linkname` is the target of a symlink.
export interface EntryInput {
  name: string
  type?: EntryType
  data?: Uint8Array
  mode?: number
  mtime?: number
  linkname?: string
}

// 'deflate' (the default) deflates each file and keeps the result only
// where it is smaller, as Info-ZIP does; 'store' compresses nothing.
export interface ZipOptions {
  method?: 'deflate' | 'store'
}

// Both refuse a name that repeats as a different entry — anything but the
// same fields and the same bytes again — an entry inside something that is
// not a directory, and a symlink that points outside the archive. Neither
// takes or makes zip64, so an archive holds at most 65534 entries and
// stays under 4 GiB.
export function zip(entries: Iterable<EntryInput>, options?: ZipOptions): Promise<Uint8Array>
export function unzip(bytes: Uint8Array): Promise<Entry[]>

// `offset` is where in the archive the reader gave up; unset from the writer.
export class ArchiveError extends Error {
  constructor(detail: string, offset?: number)
  offset: number | undefined
}

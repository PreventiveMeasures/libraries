/**
 * Strict in-memory tar, as GNU tar 1.35 writes it
 *
 * ```js
 * import { pack, unpack } from '@preventive/archive/tar.js'
 * import { packStream, unpackStream } from '@preventive/archive/tar.js'
 * ```
 *
 * Writing and reading refuse alike:
 * - a name that is not a clean relative path: absolute, with an empty or `..` segment, a drive letter,
 *   a backslash, a control or bidi character, or over 4096 bytes (255 a segment)
 * - a name that repeats as anything but the same fields and data again
 * - an entry inside a non-directory
 * - a symlink whose target climbs above the root, past `symlinksAbove`, or passes through a non-directory
 * - a hard link to no earlier entry; a hard link to a symlink is held to that symlink's rules at its own name
 *
 * @module @preventive/archive/tar.js
 */

export { ArchiveError } from './src/error.js';

/**
 * An entry's type, under tar-stream's names but for `'hardlink'` (its `'link'`)
 *
 * A `'contiguous-file'` is a file for every purpose here.
 */
export type EntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'hardlink'
  | 'fifo'
  | 'character-device'
  | 'block-device'
  | 'contiguous-file';

/**
 * An entry read from an archive: the fields of `EntryInput`, then what the archive stored
 */
export interface Entry {
  /** Relative path with `.` segments and a trailing slash dropped, or `.` for the root directory */
  name: string;
  type: EntryType;
  /** Permission bits */
  mode: number;
  uid: number;
  gid: number;
  /** Whole seconds since the epoch */
  mtime: number;
  uname: string;
  gname: string;
  /** The target of a symlink, as stored, or of a hard link, cleaned as `name` is; else `''` */
  linkname: string;
  /** A device's numbers, else 0 */
  devmajor: number;
  devminor: number;
  /** A file's contents, else empty; a view of the input where one chunk held it whole */
  data: Uint8Array;
  /** `name` before cleaning, with any ustar prefix joined on */
  storedName: string;
  /** `linkname` before cleaning */
  storedLinkname: string;
  /**
   * The entry's own pax records, in stored order, read-only and shared by every entry without any.
   * A value no field is read from is unchecked and may hold any character.
   */
  pax: ReadonlyMap<string, string>;
  /** The global pax records in effect, shared by every entry under them; `pax` wins over these */
  globalPax: ReadonlyMap<string, string>;
  /** The extended headers since the previous entry, in stored order; frozen */
  extended: readonly ExtendedHeader[];
  /** The header's magic; under `'gnu'` there is no ustar name prefix */
  magic: 'ustar' | 'gnu';
  /** The header's type flag, such as `'\0'` or `'0'` for a `'file'` */
  typeflag: string;
  /** The header's mode, file type bits included */
  storedMode: number;
  /** Whether every number in the header is octal digits, as POSIX writes, rather than blank or GNU's base 256 */
  octal: boolean;
}

/**
 * A pax header of an entry's own, a global one, or GNU's long name or long link
 */
export interface ExtendedHeader {
  kind: 'pax' | 'global' | 'longname' | 'longlink';
  magic: 'ustar' | 'gnu';
  octal: boolean;
}

/**
 * An entry to write; an `Entry` read is one to write as is, what it stored aside
 *
 * `mode` defaults to 0o644 (0o755 for a directory, 0o777 for a symlink), owners to 0 with no names,
 * `mtime` to 0.
 */
export interface EntryInput {
  /** Cleaned as `Entry.name`, so `./a` and `dir/` are taken; only a directory may end in a slash or be `.` */
  name: string;
  /** Default: `'file'` */
  type?: EntryType;
  data?: Uint8Array;
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: number;
  uname?: string;
  gname?: string;
  /** The target of a symlink or a hard link */
  linkname?: string;
  devmajor?: number;
  devminor?: number;
}

export interface SymlinkOptions {
  /**
   * How many levels above the root a relative symlink target may climb (default: 0)
   *
   * 1 lets `LICENSE -> ../../LICENSE` out of `packages/a/` archived under one top directory, as GitHub
   * archives a subtree. What a target passes through past the root is for the caller to trust.
   */
  symlinksAbove?: number;
}

/**
 * GNU tar's formats: `'gnu'`, as plain `tar` writes; `'ustar'`, refusing what it cannot hold; `'pax'`
 */
export type Format = 'gnu' | 'ustar' | 'pax';

export interface PackOptions extends SymlinkOptions {
  /** Default: `'gnu'` */
  format?: Format;
  /** tar's `-b`: zeros to a multiple of this many 512-byte blocks (default: 20) */
  blocking?: number;
}

export interface UnpackOptions extends SymlinkOptions {
  /**
   * How many entries to read, each kind and repeat counted, extended headers not (default: no limit)
   *
   * Past it, throws with `limited` set at that entry's header.
   */
  maxEntries?: number;
  /** Take a global header with no entry after it as nothing, as GNU tar does (default: refused) */
  trailingGlobal?: boolean;
}

/**
 * Write a tar archive
 *
 * Byte for byte what GNU tar writes with `--owner=0 --group=0 --numeric-owner` and, for pax,
 * `--pax-option=delete=atime,delete=ctime`; where it would cut or substitute, this refuses.
 *
 * @param entries - The entries, in order
 * @param options - Packing options
 * @returns The archive
 */
export function pack(entries: Iterable<EntryInput>, options?: PackOptions): Uint8Array;

/**
 * Read a tar archive
 *
 * Takes the extended headers GNU tar writes and refuses sparse entries.
 *
 * @param bytes - The archive
 * @param options - Unpacking options
 * @returns The entries, in order
 */
export function unpack(bytes: Uint8Array, options?: UnpackOptions): Entry[];

/**
 * `pack()` a chunk at a time, each entry's `data` yielded as the same array
 *
 * @param entries - The entries, in order
 * @param options - Packing options
 * @returns The archive's chunks
 */
export function packStream(
  entries: Iterable<EntryInput> | AsyncIterable<EntryInput>,
  options?: PackOptions
): AsyncGenerator<Uint8Array, void, undefined>;

/**
 * `unpack()` an entry at a time, each yielded as it is read
 *
 * `data` is a view of a chunk wherever one holds it whole, so an archive in one chunk is not copied.
 * No entry's data is kept, so a name that repeats is refused: such an archive is for `unpack()`.
 *
 * @param chunks - The archive's chunks
 * @param options - Unpacking options
 * @returns The entries, in order
 */
export function unpackStream(
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  options?: UnpackOptions
): AsyncGenerator<Entry, void, undefined>;

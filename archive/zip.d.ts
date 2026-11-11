/**
 * Strict in-memory zip, as Info-ZIP lays it out, deflated by the platform's `CompressionStream`
 *
 * ```js
 * import { unzip, unzipStream, zip } from '@preventive/archive/zip.js'
 * ```
 *
 * Names and symlinks are held to the rules of `@preventive/archive/tar.js`. Neither writing nor reading
 * takes zip64, so an archive holds at most 65534 entries and stays under 4 GiB.
 *
 * @module @preventive/archive/zip.js
 */

export { ArchiveError } from './src/error.js';

/**
 * A `'symlink'` is stored as Info-ZIP stores one: its target as data, its type in the Unix mode
 */
export type EntryType = 'file' | 'directory' | 'symlink';

/**
 * An entry read from an archive: the fields of `EntryInput`, then what the central directory stored
 */
export interface Entry {
  /** Relative path with `.` segments and a trailing slash dropped, or `.` for the root directory */
  name: string;
  type: EntryType;
  /** Permission bits, or the default where the maker recorded none */
  mode: number;
  /** Whole seconds since the epoch: exact from an extended timestamp, else DOS time read as UTC */
  mtime: number;
  /** A symlink's target, as stored, else `''` */
  linkname: string;
  /** A file's contents, else empty; a view of the archive where stored and given as a `Uint8Array` */
  data: Uint8Array;
  /** `name` before cleaning */
  storedName: string;
  /** The maker's system, the upper byte of "version made by": 3 for Unix, whose alone `mode` is read */
  system: number;
  /** The version needed to extract */
  version: number;
  /** The general purpose bits */
  flags: number;
  internalAttributes: number;
  /** The external attributes */
  attributes: number;
  /** The extra fields, in stored order */
  extra: ExtraField[];
}

export interface ExtraField {
  id: number;
  data: Uint8Array;
}

/**
 * An entry to write; an `Entry` read is one to write as is, what it stored aside
 */
export interface EntryInput {
  /** Cleaned as `Entry.name`, so `./a` and `dir/` are taken; only a directory may end in a slash or be `.` */
  name: string;
  /** Default: `'file'` */
  type?: EntryType;
  data?: Uint8Array;
  /** Default: 0o644, or 0o755 for a directory and 0o777 for a symlink */
  mode?: number;
  /** From 1980-01-01, the earliest DOS time and the default, to 2038-01-19, the latest extended timestamp */
  mtime?: number;
  /** A symlink's target */
  linkname?: string;
}

export interface SymlinkOptions {
  /** How many levels above the root a relative symlink target may climb, as in `tar.js` (default: 0) */
  symlinksAbove?: number;
}

export interface ZipOptions extends SymlinkOptions {
  /** `'deflate'` keeps a file deflated only where that is smaller, as Info-ZIP does (default); `'store'` does not */
  method?: 'deflate' | 'store';
}

export interface UnzipOptions extends SymlinkOptions {
  /**
   * How many bytes the entries may come to together, a symlink's target counted (default: no limit)
   *
   * Each has to inflate to exactly its declared size, so this is checked before anything is inflated;
   * past it, rejects with `limited` set.
   */
  limit?: number;
}

/**
 * Write a zip archive
 *
 * @param entries - The entries, in order
 * @param options - Zip options
 * @returns The archive
 */
export function zip(entries: Iterable<EntryInput>, options?: ZipOptions): Promise<Uint8Array>;

/**
 * Read a zip archive
 *
 * Every header, size and checksum is checked against every other, and the entries have to tile the archive.
 * An entry with a Unicode path extra field, a second name other readers take over its own, is refused.
 *
 * @param bytes - The archive
 * @param options - Unzip options
 * @returns The entries, in central directory order
 */
export function unzip(bytes: Uint8Array, options?: UnzipOptions): Promise<Entry[]>;

/**
 * `unzip()` an entry at a time, over the archive in memory or a `Blob` read a range at a time
 *
 * From a `Blob`, such as a `File` or `fs.openAsBlob()`, no more is held than the names and the entry at hand.
 * The layout is checked before the first entry, each entry's contents as it is reached. No entry's data is
 * kept, so a name that repeats is refused: such an archive is for `unzip()`.
 *
 * @param archive - The archive
 * @param options - Unzip options
 * @returns The entries, in central directory order
 */
export function unzipStream(archive: Uint8Array | Blob, options?: UnzipOptions): AsyncGenerator<Entry, void, undefined>;

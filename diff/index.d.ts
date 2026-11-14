/**
 * Line diffs as GNU diff prints them, and diffs read back
 *
 * ```js
 * import { changeSet, diff, formatChangeSet } from '@preventive/diff'
 * import { applyChangeSet, parseDiff } from '@preventive/diff'
 * ```
 *
 * A change set is replayed against the first file before it is printed, and what is printed is read
 * back and held to the change set before it is returned.
 *
 * @module @preventive/diff
 */

/**
 * A block of a change set: `a[a0..a1)` replaced by `b[b0..b1)`, counting lines from zero
 *
 * Either side may be empty but not both, and a change set's blocks are disjoint and in order.
 */
export interface Block {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  /** The lines removed, terminators included */
  remove: string[];
  /** The lines inserted, terminators included */
  insert: string[];
}

/** A line of a hunk: kept, removed or added */
export interface HunkLine {
  tag: ' ' | '-' | '+';
  text: string;
}

/** A hunk as the diff writes it */
export interface Hunk {
  /** Counting from zero */
  oldStart: number;
  /** Counting from zero */
  newStart: number;
  /** What its header carries after the ranges: under -p, the function it starts inside */
  label: string | null;
  /** In the order printed */
  lines: HunkLine[];
}

/** One file's worth of a diff */
export interface ParsedFile {
  /** The name its header gave, or null */
  old: string | null;
  /** The name its header gave, or null */
  new: string | null;
  format: 'unified' | 'context' | 'normal';
  hunks: Hunk[];
  /** The change set the hunks describe */
  blocks: Block[];
}

/** When two lines are the same line */
export interface CompareOptions {
  /** -i, in the C locale (default: false) */
  ignoreCase?: boolean;
  /** -w as `'all'`, -b as `'change'`, -Z as `'trailing'` (default: `'none'`) */
  whitespace?: 'none' | 'all' | 'change' | 'trailing';
}

/** How the change set is searched for */
export interface SearchOptions extends CompareOptions {
  /** --minimal: a shortest change set, with no cutoff and no line set aside before the search (default: false) */
  minimal?: boolean;
  /** Set aside lines matching nothing, and some matching many, as diff does; false keeps the cutoff (default: true) */
  discard?: boolean;
  /** Settle a run that could sit in more than one place, as diff does in every format (default: true) */
  slide?: boolean;
  /** --horizon-lines: how far into the lines both files share at either end a run may move */
  horizon?: number;
}

/** How a change set is printed */
export interface FormatOptions {
  /** Default: `'unified'` */
  format?: 'unified' | 'context' | 'normal';
  /** Lines of context (default: 3) */
  context?: number;
  /** What -p puts after a hunk's ranges, given the hunk's first line (default: nothing) */
  label?: ((index: number) => string | null) | null;
}

export interface DiffOptions extends SearchOptions, Omit<FormatOptions, 'format'> {
  /** `'brief'` is -q: `'Files differ\n'` or `''`, with no search (default: `'unified'`) */
  format?: FormatOptions['format'] | 'brief';
}

/**
 * The diff of two files, empty where they compare the same
 *
 * The two header lines a diff opens with are the caller's to write in front. A run moves into the lines
 * both files share at either end only as far as the context printed there, or `horizon` if that is more,
 * as diff does: so `diff` and `-U0` can agree where `-u` does not.
 *
 * @param a - The first file
 * @param b - The second file
 * @param options - Format, search and comparison options
 * @returns The diff
 */
export function diff(a: string, b: string, options?: DiffOptions): string;

/**
 * The change set `diff` prints, unprinted
 *
 * Its runs sit where a unified diff with three lines of context puts them; `horizon` is the context to
 * match instead (0 for the normal format), or `Infinity` to let a run go as far as it can, as git does.
 * With no comparison option, `applyChangeSet(a, changeSet(a, b))` is `b`.
 *
 * @param a - The first file
 * @param b - The second file
 * @param options - Search and comparison options
 * @returns The blocks, in order
 */
export function changeSet(a: string, b: string, options?: SearchOptions): Block[];

/**
 * A change set printed as `diff` prints its own: `formatChangeSet(a, b, changeSet(a, b))` is `diff(a, b)`
 *
 * Only a block's ranges are read. Throws a `DiffError`, before anything is printed, where the blocks do
 * not rebuild `b` from `a` under the comparison given.
 *
 * @param a - The first file
 * @param b - The second file
 * @param blocks - The change set
 * @param options - Format and comparison options
 * @returns The diff
 */
export function formatChangeSet(
  a: string,
  b: string,
  blocks: Pick<Block, 'a0' | 'a1' | 'b0' | 'b1'>[],
  options?: FormatOptions & CompareOptions
): string;

/**
 * Read a diff in any of the three formats, at any width
 *
 * @param text - The diff
 * @returns Each file it names, with its hunks and the change set they describe
 */
export function parseDiff(text: string): ParsedFile[];

/**
 * Carry out a change set over the file it was computed against
 *
 * @param text - The first file
 * @param blocks - The change set, each block carrying the lines it inserts, as `parseDiff` reads them
 * @returns The second file
 */
export function applyChangeSet(text: string, blocks: Block[]): string;

/** Thrown where a change set does not fit, or rebuild, the files it is given */
export class DiffError extends Error {
  constructor(detail: string);
}

/** Thrown where what was printed does not read back as the change set given */
export class FormatError extends Error {
  constructor(detail: string);
}

/** Thrown at a diff that cannot be read */
export class PatchError extends Error {
  constructor(detail: string, line?: number);
  /** Where, counting lines from zero */
  line: number | undefined;
}

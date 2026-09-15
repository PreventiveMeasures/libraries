// The typed contract for diff/index.js, hand-written because the package is
// plain JavaScript. One file rather than a .d.ts per module: index.js IS the
// surface, so the declarations below should read against it name for name,
// in the same order and under the same headings. The second entry point has
// its own, src/color.d.ts.
//
// Keep it honest. Nothing checks these against the implementation — a
// declaration that drifts is a silent lie to every caller that trusts it,
// so a change to an exported signature belongs in the same commit as the
// change here.

// One block of a change set: `a[a0..a1)` is replaced by `b[b0..b1)`, counting
// lines from zero. Either side may be empty — an insertion or a deletion —
// never both, and the blocks of a change set are disjoint and in order. A
// block read out of a diff also holds the lines it names, since a diff is
// the only place those exist.
export interface Block {
  a0: number
  a1: number
  b0: number
  b1: number
  remove: string[]
  insert: string[]
}

// One line of a hunk as the diff writes it: kept, removed or added.
export interface HunkLine {
  tag: ' ' | '-' | '+'
  text: string
}

// A hunk as it stands in the diff, its lines in the order they are printed
// and its starting lines counting from zero. `label` is what its header line
// carried after the ranges — under -p, the function it starts inside.
export interface Hunk {
  oldStart: number
  newStart: number
  label: string | null
  lines: HunkLine[]
}

// One file's worth of diff. `old` and `new` are the names its header gave,
// null when it carried none.
export interface ParsedFile {
  old: string | null
  new: string | null
  format: 'unified' | 'context' | 'normal'
  hunks: Hunk[]
  blocks: Block[]
}

// How two lines are compared. `whitespace` is diff's four settings: 'none',
// '-w' as 'all', '-b' as 'change', '-Z' as 'trailing'.
export interface CompareOptions {
  ignoreCase?: boolean
  whitespace?: 'none' | 'all' | 'change' | 'trailing'
}

// The whole of producing a diff, in one call. Empty when the two files
// compare the same. `label` names each hunk the way -p does; the two label
// lines a diff opens with are the caller's to write in front of the result.
// 'brief' is -q: whether they differ at all, without searching for how.
// `minimal` turns off the search's cutoff. `slide` settles a run that could
// sit in more than one place, and defaults to what diff does: on where
// context lines are printed, off for 'normal' and for a context format asked
// for none, which is why `diff` and `-U0` agree and `-u` does not.
export function diff(a: string, b: string, options?: CompareOptions & {
  format?: 'unified' | 'context' | 'normal' | 'brief'
  context?: number
  label?: ((index: number) => string | null) | null
  minimal?: boolean
  slide?: boolean
}): string

// A diff read back into the files it names and what it says about each.
export function parseDiff(text: string): ParsedFile[]

// A change set carried out over the file it was computed against. The blocks
// carry the lines they insert, which is what a diff records.
export function applyChangeSet(text: string, blocks: Block[]): string

// Thrown when the search's change set would not rebuild the second file.
export class DiffError extends Error {
  constructor(detail: string)
}

// Thrown when what a formatter printed does not say what it was given.
export class FormatError extends Error {
  constructor(detail: string)
}

// Thrown at a diff that cannot be read; `line` counts from zero.
export class PatchError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

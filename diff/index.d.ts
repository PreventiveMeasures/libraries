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

// One block of a change set: `a[a0..a1)` is replaced by `b[b0..b1)`. Either
// side may be empty — an insertion or a deletion — never both, and the
// blocks of a change set are disjoint and in order.
export interface Block {
  a0: number
  a1: number
  b0: number
  b1: number
}

// A run of changes close enough to share context lines, with the blocks it
// covers and the span each side prints, context included.
export interface Hunk {
  blocks: Block[]
  a0: number
  a1: number
  b0: number
  b1: number
}

// How two lines are compared. `whitespace` is diff's four settings: 'none',
// '-w' as 'all', '-b' as 'change', '-Z' as 'trailing'.
export interface CompareOptions {
  ignoreCase?: boolean
  whitespace?: 'none' | 'all' | 'change' | 'trailing'
}

// What a line is compared by. null is identity: compare records as they are.
export type LineKey = ((line: string) => string) | null

// `context` is the number of unchanged lines around a hunk, `header` the
// label lines the output opens with (already built, terminator included),
// and `fn` the -p function name for a hunk starting at a given line, or
// null for no names at all.
export interface FormatOptions {
  context: number
  header: string
  fn: ((index: number) => string | null) | null
}

export function isBinary(text: string): boolean
export function lineKey(options?: CompareOptions): LineKey
export function splitRecords(text: string): string[]
export function stripTrailingCr(text: string): string

export function diffLines(a: string[], b: string[], options?: { key?: LineKey, minimal?: boolean }): Block[]
export function sameLines(a: string[], b: string[], key?: LineKey): boolean
// Throws DiffError unless applying `blocks` to `a` yields `b`.
export function verifyChangeSet(a: string[], b: string[], blocks: Block[], key?: LineKey): void
export class DiffError extends Error {
  constructor(detail: string)
}

export function formatNormal(a: string[], b: string[], blocks: Block[]): string
export function formatUnified(a: string[], b: string[], blocks: Block[], options: FormatOptions): string
export function formatContext(a: string[], b: string[], blocks: Block[], options: FormatOptions): string

export function groupHunks(blocks: Block[], context: number, aLength: number, bLength: number): Hunk[]
// `encode` and `decode` are the UTF-8 pair the 40-byte cut is made with;
// both default to the platform's.
export function functionLine(
  lines: string[],
  before: number,
  encode?: (text: string) => Uint8Array,
  decode?: (bytes: Uint8Array) => string,
): string | null

export function quoteHeaderName(name: string, options?: { byteLocale?: boolean }): string

// Hand-written against names.js; a change to either belongs with the other.

import type { Block } from '@preventive/diff'
import type { LineOptions } from './compare.js'

// How each text is parsed, by the extension of the file it is: `mjs` a
// module, `cjs` a CommonJS module, any other (`js` unless given) a module
// where it says so (`import`, `export`) and a script where not.
// `otherExtension` is the new text's, the old one's unless given.
export interface RenameOptions {
  extension?: string
  otherExtension?: string
}

// How a text's top level is read: a module's (`module`), a CommonJS
// module's (`commonjs`, the extension's, not one found by its `require`),
// and whether its top-level names are its own (`own`: a module's, a
// CommonJS module's, or a script's that reads `require`, `module` or
// `exports` where no declaration stands for them) rather than globals
// another script may read.
export interface TextKind {
  module: boolean
  commonjs: boolean
  own: boolean
}

// Why a text keeps its own names: it does not parse, or oxc's semantic check
// finds an error in it (`unparsed`); it reads a name by its spelling (`eval`,
// `with`: `dynamic`); it holds JSX (`jsx`); outside strict code it declares a
// function in a block, which there sets its function's variable of that name
// too (`block-function`); or the names found would not bind as the old ones
// did, or a check that should never fail did, or anything else went wrong
// (`unverified`, with what failed as `invariant` where a check or an error
// says).
export type RenameReason = 'unparsed' | 'dynamic' | 'jsx' | 'block-function' | 'unverified'

// The old text with the new one's names (`text`), every name in it where it
// was: `renamed` counts the variables given a new one's name and `apart` those
// renamed apart (`r_old`), as their own name is another's on the new side;
// `kind` is how the old text was read, as bindsAlike takes it; `reads` the
// properties either text reads names through (`name`, `toString`, `stack`,
// `callee`, `caller`, as a member's or a pattern's key or any string written
// out as one), sorted, as code that reads its names may do otherwise once
// they are renamed. Or why the old text keeps its names.
export type RenameMap =
  | { text: string; renamed: number; apart: number; kind: TextKind; reads: string[]; reason?: undefined; invariant?: undefined }
  | { reason: RenameReason; invariant?: string; text?: undefined }

// The old text of a JavaScript file minified on both sides given the new
// text's names, wherever a minifier renamed a variable alike throughout: a
// declared variable's short ASCII name (three characters at most, as a
// minifier gives), not a script's top level, an export's or an import's by
// its own name, or a shorthand property's. Checked to bind every name as the
// old text did by this package's own scope analysis and again by oxc's
// minifier (bindsAlike); never thrown but for a missing oxc peer.
export function renameMap(before: string, after: string, options?: RenameOptions): RenameMap

// Whether `renamed` binds every name as `before` does, by oxc's minifier:
// both mangled, every variable named by its place alone, they read the same.
// The top level read as `kind` says, a script's (none given) left as it is.
export function bindsAlike(before: string, renamed: string, kind?: Partial<TextKind>): boolean

// The blocks of the change set from `before` to `after` under the line
// options (horizon without limit unless given, as compareLines has it) whose
// old lines, as `given` has them -- the old text renamed, line for line, as
// renameMap gives it -- are their new lines, alike as the change set has
// lines alike: what differs in renamed names alone. null where `given` has
// another number of lines than `before`.
export function markedBlocks(before: string, given: string, after: string, options?: LineOptions): Pick<Block, 'a0' | 'a1' | 'b0' | 'b1'>[] | null

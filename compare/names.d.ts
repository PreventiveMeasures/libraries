import type { Block } from '@preventive/diff'

// How each text is parsed, by the extension of the file it is: `mjs` a
// module, `cjs` a CommonJS module, any other (`js` unless given) a module
// where it says so (`import`, `export`) and a script where not.
// `otherExtension` is the new text's, the old one's unless given.
export interface RenameOptions {
  extension?: string
  otherExtension?: string
}

// Why a text keeps its own names: it does not parse, or oxc's semantic check
// finds an error in it (`unparsed`); it reads a name by its spelling (`eval`,
// `with`: `dynamic`); it holds JSX (`jsx`); outside strict code it declares a
// function in a block, which there sets its function's variable of that name
// too (`block-function`); or the names found would not bind as the old ones
// did, or a check that should never fail did, or anything else went wrong
// (`unverified`, what failed among the warnings).
export type RenameReason = 'unparsed' | 'dynamic' | 'jsx' | 'block-function' | 'unverified'

// The diff of two JavaScript files minified on both sides with renamed names
// set aside. The old side is given the new side's names wherever a minifier
// renamed a variable alike throughout (a declared variable's short ASCII name,
// not a script's top level, an export's or import's by its own name, or a
// shorthand property's), checked to bind every name as before by this
// package's scope analysis and again by oxc's minifier; formatted again where
// that changes its layout alone and still binds alike; diffed as diff -U0 has
// it; and the blocks checked to take `before` to the new side (thrown should
// they not). `reason` says why no names were given; `reads` the properties
// either text reads names through (`name`, `toString`, `stack`, `callee`,
// `caller`), sorted, as code reading its names may act otherwise renamed:
// none where none is renamed, and `name` only where a name renamed is a
// function's or class's, the one name it reads (`function f`, `f = () => {}`);
// `marks` the plain diff's blocks that differ in renamed names alone; and
// `warnings` what a check that should never fail found.
export function renamedDiff(before: string, after: string, options?: RenameOptions & { whitespace?: 'none' | 'all' | 'change' | 'trailing' }): Promise<{
  before: string
  blocks: Pick<Block, 'a0' | 'a1' | 'b0' | 'b1'>[]
  reason: RenameReason | null
  reads: string[]
  marks: Pick<Block, 'a0' | 'a1' | 'b0' | 'b1'>[]
  warnings: string[]
}>


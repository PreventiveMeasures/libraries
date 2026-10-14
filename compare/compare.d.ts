import type { Block } from '@preventive/diff'

// An entry of a tree, in the shape tar has it: what @preventive/archive's
// unpack returns and Vfs.entries yields are these as they are. `name` is a
// relative path with no empty, `.` or `..` segment, or `.` for the root
// directory -- or, under `paths: 'keys'`, any non-empty name. A file is `data`
// under `mode`, 0o644 if not given: text is kept as text, and stands for its
// UTF-8. A symlink's or a hard link's target is `linkname`, a hard link's
// spelled as the name of an entry in the same tree. A directory adds nothing,
// as git keeps none; what is not given a directory entry is implied. `data`
// and `linkname` are read only where the type uses them; a mode given is
// checked on any entry, but only a file's is compared, as only a file's is
// kept by git. A fifo or a device is refused, as is a name, link target or
// text that is not well-formed Unicode, since git could hold none of them.
export interface TreeEntry {
  name: string
  type?: 'file' | 'contiguous-file' | 'directory' | 'symlink' | 'hardlink' | 'fifo' | 'character-device' | 'block-device'
  mode?: number
  linkname?: string
  data?: string | Uint8Array
}

// A file or a link as its tree holds it: what git keeps of one. A hard link
// is a copy of what it names. `data` is the entry's own, text or bytes, not a
// copy; text and the bytes of its UTF-8 are the same content.
export type TreeFile =
  | { path: string; type: 'file'; mode: number; data: string | Uint8Array }
  | { path: string; type: 'symlink'; target: string }

// git's statuses, A, D, M, R and T.
export type Status = 'added' | 'deleted' | 'modified' | 'renamed' | 'type-changed'

// One path that differs, and what became of it. `old` is null for an added
// file and `new` for a deleted one; a renamed file has both, under their
// two paths. `similarity` is a rename's, as git's similarity index: the
// percentage of the new file the old one accounts for, 100 where the content
// is unchanged; null for anything else. `typeOnly`, on Node alone, stamps a
// change whose every side there is a file named as a declaration file
// (`.d.ts`, `.d.mts`, `.d.cts`, `.d.css.ts`) and holds types alone but for a
// runtime both sides leave the same, as proveTypeOnly proves: one touching
// erased types and comments alone, a side not there leaving an empty runtime. A
// retained module load or `export {}` runs the same on both sides only within
// one module format -- an `export {}` emits a marker transpiled to CommonJS, a
// module load runs as one format and throws as the other -- so where the runtime
// loads a module, carries a bare `export {}`, or default-exports an identifier a
// rename whose extensions fix different formats (a `.d.mts` to a `.d.cts`, or a
// `.d.ts` to or from either) is not stamped, while a rename between two of the same
// extension (two `.d.ts`, two `.d.mts`, two `.d.cts`) is; a hashbang, a directive or a pragma runs the same either
// way, so a runtime of only those cancels across formats. A modification keeps its
// path, hence its format, and a deleted file matches only an empty runtime; an
// added one an empty runtime or a single bare `export {}`, as nothing loaded it
// before and what now does runs nothing of that alone, as a module or not. A
// rename is otherwise taken by its matching
// source, as any file's is here: a relative load may resolve to another module
// once the file moves, but that is shown as a rename of its own, not traced. A
// modification of a package-resolved `.d.ts` is taken to keep its format, though
// the `package.json` resolving it could change `type` between the trees and flip
// it -- a change seen in the diff on its own, as format is read here from the
// extension, not from a package. Absent off Node, and without oxc-parser.
export interface FileStatus {
  status: Status
  old: TreeFile | null
  new: TreeFile | null
  similarity: number | null
  typeOnly?: true
}

// A status with what happened to the content: `blocks`, @preventive/diff's
// change set from the old side to the new, where a file's content is its data
// and a link's its target, and a side that is not there is empty. `insertions`
// and `deletions` count its lines, as --numstat does. Content is text when it
// is UTF-8 with no NUL; where either side is not, `binary` is true, and there
// are no blocks and no counts.
export interface FileChange extends FileStatus {
  binary: boolean
  blocks: Block[]
  insertions: number | null
  deletions: number | null
}

// How a change's lines are found, as diff's options: `horizon` is how far a
// run of lines free to move may go into the lines the two files share at
// either end -- without limit unless given, as git has it, or 0 to match
// `diff -U0` and the normal format, the context to match `diff -u` (diff's
// --horizon-lines); `whitespace` (-w as 'all', -b as 'change', -Z as
// 'trailing') and `ignoreCase` (-i) say which lines are the same, so that a
// file changed in nothing else has no blocks. Ignoring blanks or case never
// shows more lines than minding them, and where it shows no fewer, its blocks
// are those minding them: it does nothing there.
export interface LineOptions {
  horizon?: number
  whitespace?: 'none' | 'all' | 'change' | 'trailing'
  ignoreCase?: boolean
}

// `paths: 'keys'` takes names as keys, as a source map spells them
// (`webpack://app/a.js`, `../a.js`), and not as paths of a tree that must hold
// together. `renames` is git's -M: the least similarity, as a percentage
// above 0, at which a deleted file and an added one are one file renamed;
// `true` is git's default of 50, `false` finds none, and 100 only those whose
// content is unchanged. `renameGroup`, given, keeps renames within a group:
// files are paired only where it gives their paths the same group, a
// package's for one.
//
// `renamesByPath`, unless false, also takes a deleted file and an added one
// for a rename however little alike, where their paths say so: where they
// differ only by `lib` for `src` or a TypeScript extension for its JavaScript
// one (`.ts`, `.mts`, `.cts`, `.tsx` for `.js`, `.mjs`, `.cjs`, `.jsx`), or
// both, the best scoring of a file's such partners; and, as triage's Compare
// pairs them, where they share a name less its extension, the extension's
// family (scripts, `.js` to `.tsx`; styles, `.css` `.scss` `.sass` `.less`)
// and their directories but for one -- not a package's name under
// node_modules -- each the other's only such partner. Either gives way only
// to a candidate that is a rename by itself and scores at least halfway from
// the pair's score to 100%. And before git scores every pair left, lest a file
// elsewhere take either version, it pairs bundle chunks whose hash changed
// with their content: in one directory, names alike but for what follows the
// last separator (`-`, `.`, `_`) they share, up to the extensions they end in
// alike, six or more characters of a hash's (letters, digits, `-` and `_`, not
// lowercase letters alone), as `index-CyWAfh-p.js` and `index-hRvO4yU2.js`
// are, or `main.3f9a2c1d.chunk.js` and `main.8b7e6a5f.chunk.js`. Minified onto
// a line, such a chunk scores little as git splits it, so it is scored with
// its spans ending after `,` `;` `=` `{` `}` too, and taken however it scores
// where each is the other's only such chunk, as a pair by path is (a build's
// chunk rewritten: playwright's dashboard `index-*.js`, 31% alike from 1.61.1
// to 1.62.0), else at git's stricter score for a basename, halfway from -M's
// to 100%: the best pairs first, its similarity that score, giving way as a
// pair by path does but only where git takes the candidate it gives way to,
// and none past the rename limit, as they are scored. git has no such passes,
// so false is git's own -M.
//
// `renameLimit` is git's diff.renameLimit: when more deleted files times added
// files are left, in a group, after the renames that need no scoring than its
// square, the rest are not looked for. 1000 unless given; Infinity for no
// limit. `lines: false` gives statuses alone, their lines found by
// formatPatch when wanted.
export interface CompareOptions extends LineOptions {
  paths?: 'tree' | 'keys'
  renames?: boolean | number
  renamesByPath?: boolean
  renameGroup?: (path: string) => unknown
  renameLimit?: number
  lines?: boolean
}

// Every path the trees do not have the same, in git's order: by path in code
// point order, a rename at its new one. A file is the same when its content
// and its mode are, a link when its target is. Throws a CompareError for a
// tree that does not hold together, naming the path and which tree. A
// `lines` not known to be true or false types the result as either.
export function compareTrees(a: Iterable<TreeEntry>, b: Iterable<TreeEntry>, options: CompareOptions & { lines: false }): FileStatus[]
export function compareTrees(a: Iterable<TreeEntry>, b: Iterable<TreeEntry>, options?: CompareOptions & { lines?: true }): FileChange[]
export function compareTrees(a: Iterable<TreeEntry>, b: Iterable<TreeEntry>, options?: CompareOptions): FileStatus[] | FileChange[]

// The changes as `git diff` writes them, without its `index` lines, with
// `context` lines around each change, 3 unless given. A file's mode is
// written in full, where git would only have 644 or 755. The hunks are each
// change's own blocks, found under the line options given here, which must
// carry its old content to its new under them, or @preventive/diff's
// DiffError is thrown; a change without blocks has them found here.
export function formatPatch(changes: Iterable<FileStatus | FileChange>, options?: LineOptions & { context?: number }): string

// The ranges `[from, to)` that changed within a removed line and the added
// line it pairs with, word by word (runs of letters and digits, whitespace,
// any other character), as the shortest edit script pairLines weighs lines by
// finds them: every character that changed is in one, and two split by
// whitespace alone are merged, taking it in. None where the lines are the
// same; null, no word view, where they are mostly replaced, or past 2000
// characters or 800 words, so that all of either line is taken as changed.
export function wordRanges(left: string, right: string): { a: [number, number][]; b: [number, number][] } | null

// A change's removed lines paired with its added lines, in order: two lines
// pair only where wordRanges gives them ranges (a word in common, at most six
// in ten of either changed), the most such pairs, and of those the most alike.
// Where weighing every pair takes too long (many long lines alike), each
// removed line in turn takes the most alike of the next six added lines.
// `[i, j]` indices into the two lists; none where either holds more than 200
// lines.
export function pairLines(olds: readonly string[], news: readonly string[]): [number, number][]

// Whether diff -w, as `blocks` were found with it, keeps as unchanged a line
// whose blanks between the same two characters (or before the first or after
// the last) changed and mix more than one kind, as spaces turned to tabs. True
// too where `blocks` don't carry `before` to `after` under -w, as such blocks
// may hide anything.
export function hidesMixedWhitespace(before: string, after: string, blocks: readonly Pick<Block, 'a0' | 'a1' | 'b0' | 'b1'>[]): boolean

// A rename as `git diff --stat` writes one, in parts for a view to color: the
// directories both share (`head`), what changed (`from`, `to`), down to the
// extension where that is all unless `extension` is false, and the rest (`tail`).
export function renameParts(from: string, to: string, options?: { extension?: boolean }): { head: string; from: string; to: string; tail: string }

// The directory one tree's files sit under in the other: `base: ''` and
// `other` the directory where the old tree's `a.js` is the new one's
// `src/a.js`, or the other way round.
export interface Root { base: string; other: string }

// The root between two trees, or null, and each old path as the new tree lays
// it out: through the root where the new tree has it there, else as it is where
// it has that, else through the root clear of every path taken, a `../` further
// out. A root is taken where it pairs more files than none, and at least half
// the files of the side without the directory; a tie either way is none.
export interface Layout { root: Root | null; paths: Map<string, string> }
export function treeLayout(basePaths: Iterable<string>, otherPaths: Iterable<string>): Layout

// An old module's directory where the layout placed one of its `files` (paths
// within it), else moved with the root: one outside it a `../` further out for
// each level of the root, `.` as it is.
export function layoutDir(layout: Layout, dir: string, files: Iterable<string>): string

// Both trees' package directories by path, either map null, as the new tree
// lays out its files: the old ones moved with the root, the new ones kept.
export function layoutPackageDirs(baseDirs: Map<string, string> | null, otherDirs: Map<string, string> | null, layout: Layout): Map<string, string> | null

// A view's directory `prefix` with where the root puts it on each side
// (`./dir/`, `./src/dir/`); a prefix the root doesn't lead is dropped.
export function rootLabel(root: Root | null, prefix: string): { prefix: string; from: string | null; to: string | null }

// Why a text is not proven to hold types alone: proving needs Node, whose type
// stripping is held to oxc's tree, and oxc-parser, an optional peer, there,
// and is not asked of a stripping that once failed as may leave it unsound
// (`unsupported`); Node's stripping or oxc finds an error in it, as in
// `export const x: number`, which only a declaration file may write, or it
// nests too deep for either (`unparsed`); a statement is neither erased nor a
// module load binding a type nor a bare `export {}`, as `export { type A }`,
// `export as namespace N` and a side-effect load that binds nothing are not
// (`code`); or Node's stripping, or a reading of what it leaves, does not find
// what oxc does (`disagree`).
export type TypeOnlyReason = 'unsupported' | 'unparsed' | 'code' | 'disagree'

// Whether `text`, read as TypeScript, holds types alone but for a `runtime` a
// change must leave byte for byte untouched, so that Node, which reads a `.d.ts`
// as the `.ts` it is named and runs what its type stripping leaves, runs only
// that of it:
// - oxc's tree has no statement but those stripping erases whole -- interfaces,
//   type aliases, anything `declare`d (bodies and initializers with it), a
//   function's signature, `import type` and `export type`, a namespace of types
//   alone -- and those it leaves to run: a module load that binds from it
//   (`import`, `export *`, `export { a } from` a module, `import { type A }` whose
//   inline `type` loads it all the same), a bare `export {}`, and `export default E`
//   on a bare identifier (the idiom a declaration file's default export takes,
//   `declare const _d: T; export default _d`). `export { type A }`
//   is code, not a run statement: it is `export {}` only once stripping takes its
//   specifiers out, not as the source has it; nor is `export as namespace N`, left
//   as invalid JavaScript that throws when imported, nor a side-effect load that
//   binds nothing -- a bare `import`, an empty `import {}`, `export {}` with a
//   source -- which loads a module for no type, nor an `export default` of anything
//   but a bare identifier (a value expression, an object, a class body);
// - Node's stripTypeScriptTypes erases, to the character, what oxc finds erased
//   and leaves nothing it does not, but comments, the hashbang and those;
// - what it leaves, the run statements set aside, read token by token apart from
//   either, holds nothing else;
// - nor does what its transform mode (--experimental-transform-types) leaves.
// `runtime` is built from those run statements and from the directive and pragma
// comments stripping keeps -- a `/// <reference ... />`, a `//# sourceMappingURL=`
// or `//# sourceURL=` and their legacy forms, comments a tool reads as more than prose --
// the hashbang first and the rest in source order, joined by newlines; empty where the
// file erases whole and carries none. A run statement is reduced: an inline type specifier
// stripping blanks within it (`import { type A, B }`), and any comment within it, each become
// a single blank, so a change to only those leaves `runtime` unchanged; its executable text and
// its module specifier are kept to the character, so a load of another module still differs.
// Known limit: that kept text is compared as written, so a change leaving a load runtime-identical
// yet reformatting it withholds the stamp rather than passing -- a removed trailing inline-type
// specifier leaving its comma (`{ B, }` where `{ B }` would stand), or a comment added where no
// blank sat. This errs safe: the stamp is never given wrongly, only sometimes withheld. A
// directive, a pragma and the hashbang stand as stripping leaves them, since what they say is the
// point. A triple-slash directive counts only in the prologue,
// before the first statement, where TypeScript honours it; below one it is prose, so moving
// it out of the prologue drops it from `runtime`, as removing it does. `loads` is whether any
// run statement is a module load, a bare `export {}`, or an `export default` on an identifier: the runtime that runs as one module
// format and throws, or emits a different marker, as the other -- a hashbang, directive or
// pragma does not. A change is types only where both sides prove and leave the same `runtime`:
// it then touches erased types and ordinary comments alone. Where `loads`, a rename across
// module formats does not cancel (see compareTrees' `typeOnly`); a runtime without it runs the
// same either way and cancels across them. `at` is where in `text` what is found
// begins, where it has a place. Throws a TypeError where `text` is not a
// well-formed string. Node warns once that stripTypeScriptTypes is experimental.
export function proveTypeOnly(text: string): { proven: true; runtime: string; loads: boolean } | { proven: false; reason: TypeOnlyReason; at: number | null }

// `path` is the name at fault as its entry spelled it, and `tree` which tree
// holds it.
export class CompareError extends Error {
  constructor(detail: string, path?: string, tree?: 'old' | 'new')
  path: string | undefined
  tree: 'old' | 'new' | undefined
}

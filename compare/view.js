// What a view of two trees' changes reads them by, given the files they pair:
// changed lines read word by word, which removed line was edited into which
// added one, and whether diff -w hides blanks of more than one kind changing;
// a rename written as `git diff --stat` writes one; and a directory and the
// root as the new tree lays them out. compare.js gives these too; this loads
// none of compareTrees, nor what finds the root, so a view whose files are
// paired elsewhere (a server's) loads none of the pairing. Typed and described
// in compare.d.ts.

export { pairLines } from './src/pairs.js'
export { wordRanges } from './src/words.js'
export { hidesMixedWhitespace } from './src/whitespace.js'
export { renameParts } from './src/paths.js'
export { layoutDir, rootLabel } from './src/root.js'

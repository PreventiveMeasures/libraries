// babel-plugin-module-resolver's `alias` option. A key starting `^` or ending
// `$` is a regular expression, whose groups a target's `\N` take; any other
// matches itself and what is under it. A target starting `./` or `../` is a
// path from `cwd`.
export type Aliases = Readonly<Record<string, string>>

// What the first alias matching `specifier` rewrites it to in `file`, as the
// plugin writes it (a path relative to `file`), else null. Absolute paths.
export type AliasFor = (file: string, specifier: string) => string | null

// Throws a TypeError where `alias` isn't one, a SyntaxError on a key that
// isn't a valid regular expression.
export function createAliases(alias: Aliases, cwd: string): AliasFor

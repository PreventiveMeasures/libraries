// `text` formatted by oxfmt as a file with `extension`, changing what is written
// no more than layout needs (keys keep their quotes, no trailing commas or arrow
// parentheses are added, template literals stay), the copy used only where checks
// of oxfmt's output, apart from oxfmt, find it changes the layout alone:
// - a script's (`js`, `mjs`, `cjs`, `jsx`, `ts`, `mts`, `cts`, `tsx`) syntax tree as
//   oxc parses it, its comments and its text;
// - a style sheet's (`css`) tree as css-tree, an optional peer, parses it, but for
//   the case of what CSS reads in any case and zeros in a number that change neither
//   its value nor its type (`.50` as `0.5`, but not `1.0` as `1`, an integer);
// - JSON's strings and comments as written.
// Otherwise an error: no check for the kind of file (`unsupported`, CSS without
// css-tree), it does not parse (`unformattable`) or would change more
// (`pretty-mismatch`). Rejects only where the optional oxfmt peer is missing.
export function format(text: string, extension: string): Promise<{ code: string } | { error: 'unsupported' | 'unformattable' | 'pretty-mismatch' }>

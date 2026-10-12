// Hand-written against pretty.js; a change to either belongs with the other.

// `text` formatted by oxfmt as a file with `extension` (a script, `css` or
// `json`), changing what is written no more than layout needs (keys keep their
// quotes, no trailing commas or arrow parentheses are added, template literals
// stay), the copy used only where checks of oxfmt's output, apart from oxfmt,
// find it changes the layout alone: a script's syntax tree as oxc parses it,
// strings and comments as written, the rest as formatting may respell it.
// Otherwise an error: it does not parse (`unformattable`) or would change more
// (`pretty-mismatch`). Rejects only where the optional oxfmt peer is missing.
export function formatChecked(text: string, extension: string): Promise<{ code: string } | { error: 'unformattable' | 'pretty-mismatch' }>

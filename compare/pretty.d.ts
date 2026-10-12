// Hand-written against pretty.js; a change to either belongs with the other.

// How oxfmt formats: changing what is written no more than layout needs. Keys
// keep their quotes, no trailing commas or arrow parameters' parentheses are
// added, and template literals' contents are left as they are.
export const PRETTY_OPTIONS: {
  quoteProps: 'preserve'
  trailingComma: 'none'
  arrowParens: 'avoid'
  embeddedLanguageFormatting: 'off'
}

// Whether `formatted` is `text` but for its layout, by checks apart from the
// formatter: strings and comments as written but for quotes and a comment's
// indentation, the rest as formatting may respell it, and for a script (`js`,
// `mjs`, `cjs`, `jsx`, `ts`, `mts`, `cts`, `tsx`) both syntax trees as oxc
// parses them. Only scripts, `css` and `json` compare; anything else, or text
// a check can't read, is not the same.
export function sameCode(text: string, formatted: string, extension?: string): boolean

// `text` formatted by oxfmt as a file with `extension`, used only where
// sameCode takes it: an error where it does not parse (`unformattable`) or
// would change more than its layout (`pretty-mismatch`). Rejects only where
// the optional oxfmt peer is missing.
export function formatChecked(text: string, extension: string): Promise<{ code: string } | { error: 'unformattable' | 'pretty-mismatch' }>

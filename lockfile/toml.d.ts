// Hand-written against toml.js; a change to either belongs with the other.

// Tables have a null prototype: `__proto__`, `constructor` and the like are
// ordinary keys, and an absent key reads as undefined.
export interface TomlTable {
  [key: string]: TomlValue
}

export type TomlValue = string | number | boolean | TomlDateTime | TomlValue[] | TomlTable

// Reads the TOML 1.0 that Cargo.lock, uv.lock, poetry.lock, pylock.toml and
// foundry.toml are written in, comments dropped (src/toml/parse.js and
// value.js list it): bare, quoted and dotted keys, tables and arrays of
// tables by TOML's rules of who may write a table, strings on one line,
// decimal integers with or without underscores, booleans, offset
// date-times, arrays and inline tables. Anything else is a TomlError that
// names it: multi-line strings, floats, hexadecimal, octal and binary
// integers, local dates and times, a date-time with a space or a lower-case
// `t` or `z`, TOML 1.1's escapes, times without seconds, and inline tables
// across lines or with a trailing comma, an integer past 2^53, nesting past
// 64 levels; and anything that is not TOML at all.
//
// `text` is the file decoded as UTF-8, strictly: `new TextDecoder('utf-8',
// { fatal: true })`, or it may be damaged. A byte order mark, a lone
// surrogate and U+FFFD, which a lenient decoder writes where bytes are not
// UTF-8, are refused.
export function parseToml(text: string): TomlTable

// An offset date-time, as written: `text` is its RFC 3339 spelling, with
// its fractional seconds and offset as they were, and toDate() the instant
// it names, to the millisecond. Frozen. The constructor takes only what
// the parser would read, and throws a TypeError at anything else.
export class TomlDateTime {
  constructor(text: string)
  readonly text: string
  toString(): string
  toJSON(): string
  toDate(): Date
}

// `line` counts from zero; the message counts from one.
export class TomlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

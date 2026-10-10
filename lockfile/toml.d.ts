// Tables have a null prototype: `__proto__` and the like are ordinary keys.
export interface TomlTable {
  [key: string]: TomlValue
}

// An integer is a number, or a bigint past +/-(2^53 - 1); a float is a
// TomlFloat, so that `1.0` is not the integer `1`.
export type TomlValue = string | number | bigint | boolean | TomlFloat | TomlDateTime | TomlValue[] | TomlTable

// Reads TOML 1.0, as Cargo, uv, Poetry and Foundry files are written.
// Throws a TomlError for what it does not read: local dates and times,
// TOML 1.1, inline tables across lines, numbers past 64 bits or a double,
// nesting past 64 levels. `text` has to be decoded strictly, BOM kept:
// `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`.
export function parseToml(text: string): TomlTable

// Whether parseToml read `value` as a table written inline, `{ ... }`, as
// some readers take one apart from a table a header or a dotted key makes:
// toml_edit, for one, gives it as a value rather than as a table.
export function isInlineTable(value: unknown): boolean

// `text` as written, toDate() to the millisecond. Frozen; the constructor
// throws a TypeError for what the parser would not read.
export class TomlDateTime {
  constructor(text: string)
  readonly text: string
  toString(): string
  toJSON(): string
  toDate(): Date
}

// `text` as written, `value` the double. Frozen; the constructor throws a
// TypeError for what the parser would not read.
export class TomlFloat {
  constructor(text: string)
  readonly text: string
  readonly value: number
  valueOf(): number
  toString(): string
  toJSON(): number
}

// `line` counts from zero; the message counts from one.
export class TomlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

// The typed contract for yaml/index.js, hand-written because the package is
// plain JavaScript. One file rather than a .d.ts per module: index.js IS the
// surface, so the declarations below should read against it name for name,
// in the same order and under the same headings.
//
// Keep it honest. Nothing checks these against the implementation — a
// declaration that drifts is a silent lie to every caller that trusts it,
// so a change to an exported signature belongs in the same commit as the
// change here.

// What a document can hold: the core schema's scalars, sequences of them,
// and mappings with string keys. A mapping comes back with a null prototype:
// nothing is inherited, so a key named like an Object.prototype member reads
// as its own value or as undefined, and `__proto__` is a key like any other.
export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping
export interface YamlMapping {
  [key: string]: YamlValue
}

// A document read into the data it carries. The top level is a mapping or a
// sequence — a document that is a lone scalar is refused, as is everything
// outside the subset pnpm writes; src/parse.js opens with the list.
export function parseYaml(text: string): YamlMapping | YamlValue[]

// Thrown at a document that cannot be read, malformed or refused alike;
// `line` counts from zero and the message from one.
export class YamlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

// Hand-written against index.js; a change to either belongs with the other.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping

// Mappings have a null prototype: `__proto__`, `constructor` and the like are
// ordinary keys, and an absent key reads as undefined.
export interface YamlMapping {
  [key: string]: YamlValue
}

// The subset of YAML pnpm writes lockfiles in (src/parse.js lists it); a
// YamlError at anything else, a document that is a lone scalar included.
export function parseYaml(text: string): YamlMapping | YamlValue[]

// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

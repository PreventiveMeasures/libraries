export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping

// Mappings have a null prototype: `__proto__` and the like are ordinary keys.
export interface YamlMapping {
  [key: string]: YamlValue
}

// Reads the YAML pnpm writes lockfiles in; throws a YamlError for anything
// else, a lone scalar, or nesting past 64 levels. parseYaml reads one
// document; parseYamlStream every one, each after `---`.
export function parseYaml(text: string): YamlMapping | YamlValue[]
export function parseYamlStream(text: string): (YamlMapping | YamlValue[])[]

// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

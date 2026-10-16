export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMapping

// Mappings have a null prototype: `__proto__` and the like are ordinary keys.
export interface YamlMapping {
  [key: string]: YamlValue
}

export interface YamlOptions {
  // Reads the YAML GitHub reads a workflow or an action's metadata in, past
  // what pnpm writes: a value left empty, null; a sequence under a key at
  // the key's own column; `>` folded block scalars, a comment after a block
  // scalar's header and its indicators in either order; plain and quoted
  // scalars and flow collections over more than one line, flow collections
  // nested and a comma after the last entry; a flow mapping's value left
  // empty, or its `:` too, null, a `:` after spaces or right after a quoted
  // key (`{"a":1}`), and a flow sequence's `k: v` a mapping of one; anchors
  // and aliases, an alias the very value its anchor names, in block context
  // alone, a document they would expand past 2^20 nodes or 128 levels as
  // copies refused; and a tab in a block scalar's text, but nowhere else but
  // a comment line or one of nothing but spaces and tabs.
  // Scalars are typed as without it, and the rest is refused as without it:
  // tags, merge keys, which GitHub doesn't read either, directives and end
  // markers.
  workflow?: boolean
  // Set, for each block mapping and sequence read, to where its values are:
  // a mapping's a Map by key, a sequence's an array, of the line each
  // entry's key or `-` is on, counting from zero; an explicit key's, the
  // line of its `? `.
  lines?: WeakMap<YamlMapping | YamlValue[], Map<string, number> | number[]>
}

// Reads the YAML pnpm writes lockfiles in; throws a YamlError for anything
// else, a lone scalar, or nesting past 64 levels, and a TypeError for
// options it doesn't know. parseYaml reads one document; parseYamlStream
// every one, each after `---`.
export function parseYaml(text: string, options?: YamlOptions): YamlMapping | YamlValue[]
export function parseYamlStream(text: string, options?: YamlOptions): (YamlMapping | YamlValue[])[]

// `line` counts from zero; the message counts from one.
export class YamlError extends Error {
  constructor(detail: string, line?: number)
  line: number | undefined
}

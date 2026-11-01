// An ESTree node, as oxc-parser or any ESTree parser gives one.
export interface Node {
  type: string
  [key: string]: unknown
}

export function walkAst(node: Node | Node[], fn: (node: Node) => void): void

// The string a literal or a template with no substitutions holds.
export function literalString(node: Node | null | undefined): string | null

// The method `node` calls on an object, on the one named `object` where given.
export function memberCall(node: Node | null | undefined, object?: string): string | undefined

// Each entry of the lists `program` names under the keys of `lists` (to what
// each entry is taken as), read through spreads, variables, branches, the
// array methods making a list of another, and push, unshift and concat.
export function readLists(program: Node, lists: ReadonlyMap<string, string>, entry: (type: string, node: Node) => void): void

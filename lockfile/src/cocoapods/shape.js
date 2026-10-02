// The shapes the nodes yaml.js reads come in, each checked where it is
// read, as shape.js checks the values the other readers' parsers hand
// back: a scalar of a type, a sequence's items and a mapping's entries,
// each entry with where it is, a symbol's key as `:name`. A sequence or a
// mapping left out is an empty one.

import { at, quote } from '../error.js'
import { checkerOf, primitives, text } from '../shape.js'

function kind(node) {
  if (node === undefined) return 'nothing'
  if (node.kind === 'seq') return 'a sequence'
  if (node.kind === 'map') return 'a mapping'
  return node.type === 'string' ? `the string ${quote(node.value)}` : `the ${node.type} ${String(node.value)}`
}

const { refuse } = primitives(kind)

export function scalarOf(node, type, where) {
  if (node?.kind !== 'scalar' || node.type !== type) throw refuse(`a ${type}`, node, where)
  return node.value
}

export const textOf = (node, where) => text(scalarOf(node, 'string', where), where)

// A reader of a string that `is` holds, refusing any other as not `what`.
export const checker = checkerOf(textOf)

export function itemsOf(node, where) {
  if (node === undefined) return []
  if (node.kind !== 'seq') throw refuse('a sequence', node, where)
  return node.items
}

// Each entry as `[key, value, where]`, its key the scalar it is.
export function entriesOf(node, where) {
  if (node === undefined) return []
  if (node.kind !== 'map') throw refuse('a mapping', node, where)
  return node.entries.map(({ key, value }) => [key, value, at(where, key.type === 'symbol' ? `:${key.value}` : String(key.value))])
}

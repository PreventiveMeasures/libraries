// The variables the names given would read wrongly: two of a scope named
// alike, a `var` named as a block's it hoists past, a body's as its parameter,
// or a name read resolving to another variable, a global's to any.

import { hoistedPast, resolve } from './syntax.js'

export function misread({ scopes, variables, occurrences, globals }, given) {
  const names = new Map(scopes.map((at) => [at, new Map()])), wrong = new Set()
  const named = (at) => names.get(at)
  for (const at of scopes) {
    for (const variable of at.names.values()) {
      const taken = named(at).get(given.get(variable))
      if (taken) wrong.add(taken).add(variable)
      else named(at).set(given.get(variable), variable)
    }
  }
  for (const variable of variables) {
    for (const path of variable.through ?? []) for (const there of hoistedPast(variable, path, given.get(variable), named)) wrong.add(there).add(variable)
  }
  for (const at of scopes) {
    if (!at.parameters) continue
    for (const variable of new Set(at.names.values())) {
      const parameter = named(at.parameters).get(given.get(variable))
      if (parameter && parameter !== variable) wrong.add(parameter).add(variable)
    }
  }
  for (const [, variable, where] of occurrences) {
    const found = resolve(given.get(variable), where, named)
    if (found === variable) continue
    wrong.add(variable)
    if (found) wrong.add(found)
  }
  for (const [node, where] of globals) {
    const found = resolve(node.name, where, named)
    if (found) wrong.add(found)
  }
  return wrong
}

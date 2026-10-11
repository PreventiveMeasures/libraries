// The variables the names given (`given`) would read wrongly: two of one
// scope named alike, a `var` named as one declared in a block it is written
// in (`{ let a; { var a } }` does not compile, and a `catch (a)` parameter
// would take its value, unless a nearer one of its own took it already), one
// of a function's body named as its parameter (which it would then be, or
// start as, past a default: `(a, b = 1) => { var c }` -> `var b`), a name read
// resolving to another variable than its own, or a global's to a variable.

import { hoistedPast, resolve } from './syntax.js'

// Each scope's variables by the names given them, and those two of a scope
// would share.
function givenNames(scopes, given, wrong) {
  const names = new Map(scopes.map((at) => [at, new Map()]))
  for (const at of scopes) {
    for (const variable of at.names.values()) {
      const taken = names.get(at).get(given.get(variable))
      if (taken) wrong.add(taken).add(variable)
      else names.get(at).set(given.get(variable), variable)
    }
  }
  return names
}

export function misread({ scopes, variables, occurrences, globals }, given) {
  const wrong = new Set()
  const names = givenNames(scopes, given, wrong)
  const named = (at) => names.get(at)
  for (const variable of variables) {
    for (const path of variable.through ?? []) {
      for (const there of hoistedPast(variable, path, given.get(variable), named)) wrong.add(there).add(variable)
    }
  }
  for (const at of scopes) {
    if (!at.parameters) continue
    for (const variable of new Set(at.names.values())) {
      const parameter = names.get(at.parameters).get(given.get(variable))
      if (parameter && parameter !== variable) wrong.add(parameter).add(variable)
    }
  }
  for (const [, variable, where] of occurrences) {
    const found = resolve(given.get(variable), where, named)
    if (found !== variable) {
      wrong.add(variable)
      if (found) wrong.add(found)
    }
  }
  for (const [node, where] of globals) {
    const found = resolve(node.name, where, named)
    if (found) wrong.add(found)
  }
  return wrong
}

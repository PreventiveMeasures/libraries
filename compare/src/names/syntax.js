// Which names renaming touches, and the rules of the language it leans on.

// A minifier's names: short and ASCII, so that none is renamed to or from one
// a reader can't tell apart (a Cyrillic a, U+0430, or a zero-width joiner).
export const RENAMED_MAX_LENGTH = 3
export const MINIFIED = /^[A-Za-z_$][\w$]*$/u
// Properties code reads names through, which renaming changes: as a member's
// or a pattern's key, or any string written out (not `'' + f`).
export const NAME_READS = new Set(['name', 'toString', 'stack', 'callee', 'caller'])
// What a name renamed apart ends in: `e_old`, then `e_old2`.
export const APART = '_old'
// Words no variable may be named, in strict code or in a module.
export const RESERVED = new Set(`await break case catch class const continue debugger default delete do else enum export extends false finally for
  function if implements import in instanceof interface let new null package private protected public return static super switch this throw
  true try typeof var void while with yield arguments eval`.split(/\s+/u))

// A check that should never fail: renameMap then gives no names, and tells why.
export class Broken extends Error {}
export function holds(condition, what) {
  if (!condition) throw new Broken(what)
}

// The names a pattern declares: `{ a, b: [c, ...d] = e }` declares a, c and d.
export function declared(pattern, out = []) {
  switch (pattern?.type) {
    case 'Identifier': out.push(pattern); break
    case 'ObjectPattern': for (const property of pattern.properties) declared(property.type === 'RestElement' ? property.argument : property.value, out); break
    case 'ArrayPattern': for (const element of pattern.elements) declared(element, out); break
    case 'RestElement': declared(pattern.argument, out); break
    case 'AssignmentPattern': declared(pattern.left, out); break
    default: break
  }
  return out
}

export function saysStrict(statements) {
  for (const statement of statements) {
    if (typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

// The variable a name read in `from` stands for, or null for a global's;
// `names` gives a scope's names, its own unless others are asked after.
export function resolve(name, from, names = (at) => at.names) {
  for (let at = from; at; at = at.parent) if (names(at).has(name)) return names(at).get(name)
  return null
}

// The variables of `name` a `var` hoists past up to its function: each a
// redeclaration that does not compile, but past a `catch` whose simple
// parameter it is, or one of its name beyond such a one.
export function hoistedPast(variable, path, name, named) {
  const met = []
  let caught = false
  for (const at of path) {
    const there = named(at).get(name)
    if (there === variable) caught ||= Boolean(at.caught)
    else if (there && !(at.caught && at.simple && caught)) met.push(there)
  }
  return met
}

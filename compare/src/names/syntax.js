// What renaming reads JavaScript by: which names it renames, and the few
// rules of the language it leans on, shared by the modules beside this one.

// Names a minifier gives: longer ones are an API's or a person's, and one
// changed is a change. ASCII alone, as a minifier gives: no name renamed to
// or from one a reader can't tell from another (a Cyrillic a, U+0430, for
// `a`, or one with a zero-width joiner in it).
export const RENAMED_MAX_LENGTH = 3
export const MINIFIED = /^[A-Za-z_$][\w$]*$/u

// Properties through which code reads names: a function's or a class's
// (`name`, its source by `toString`, a stack's frames, `arguments.callee` and
// `caller`), which renaming changes. Read where code says so: a member or a
// pattern's key (`f.name`, `const { name } = f`), or any string written out
// as one (`f["name"]`, `Reflect.get(f, "name")`, `const k = "name"; f[k]`),
// not where it reads one otherwise (`'' + f`, a key built up).
export const NAME_READS = new Set(['name', 'toString', 'stack', 'callee', 'caller'])

// What a name renamed apart ends in, numbered past the first as it takes to
// be one neither side uses: `e_old`, `e_old2`.
export const APART = '_old'

// Words no variable may be named: reserved anywhere, in strict code or in a
// module, and the two strict code forbids binding.
export const RESERVED = new Set(`await break case catch class const continue debugger default delete do else enum export extends false finally for
  function if implements import in instanceof interface let new null package private protected public return static super switch this throw
  true try typeof var void while with yield arguments eval`.split(/\s+/u))
export const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A check that should never fail, a failure being a mistake here: the names
// are then not given (renameMap), and what failed is told.
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

// Whether statements begin by saying their code is strict: among the strings
// they open with, which a statement of any other kind ends.
export function saysStrict(statements) {
  for (const statement of statements) {
    if (typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

// The variable a name stands for where it is read, from that scope outward,
// or null for none: a global's. `names` gives a scope's names, its own unless
// another naming is asked after.
export function resolve(name, from, names = (at) => at.names) {
  for (let at = from; at; at = at.parent) if (names(at).has(name)) return names(at).get(name)
  return null
}

// The variables a `var`'s path from where it is written up to its function's
// scope meets of its name, `named` reading a scope's names: each a
// redeclaration that does not compile (`{ let a; { var a } }`), but past a
// `catch` whose simple parameter it is, or past one of its name beyond such a
// one.
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

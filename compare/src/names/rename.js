// The old side of a JavaScript file minified on both sides given the new
// side's names, wherever a minifier renamed a variable alike throughout, so
// that the two then diff as they are.
//
// Both sides are parsed (oxc-parser) and each name resolved, by JavaScript's
// scopes, to the variable it stands for (analyze). Lines pair up as they are
// with their variables' short names set aside, and every pair tells which
// variable became which (pairing): an old one and a new one each the other's
// most told of is renamed to the new one's name, on every line, removed ones
// too. Any other old variable whose name the new side uses is renamed apart
// (`r_old`), as it is none of the new side's: a line reading it never reads
// as one reading the new side's. The names so given must leave each name read
// where it was resolving to the same variable, a global's to none (misread),
// and those that would not are renamed apart instead. The renamed text must
// then bind as the old one did by oxc's minifier, whose scope analysis is
// apart from this one (bindsAlike), else it is not used: a mistake here costs
// a file its names, never its sense. Checks that should never fail stand
// between the steps (check.js).

import { getOxc } from '#oxc'
import { analyze } from './analyze.js'
import { bindsAlike } from './binds.js'
import { checkAnalysis, checkGiven, checkPairing, checkRenamed } from './check.js'
import { misread } from './misread.js'
import { pairing } from './pairing.js'
import { APART, Broken, holds } from './syntax.js'

// Each old variable's name: its counterpart's, its own, or, where the new
// side uses its own for another, one apart. Those the names would read
// wrongly are renamed apart instead, a changed line's pairing first; null
// where some can't be.
function givenNames(a, b, { map, weak }) {
  const apart = (name) => {
    let named = name + APART
    for (let n = 2; a.names.has(named) || b.names.has(named); n++) named = `${name}${APART}${n}`
    return named
  }
  const given = new Map()
  for (;;) {
    for (const variable of a.variables) {
      const own = variable.aside && !map.has(variable) && b.names.has(variable.name) ? apart(variable.name) : variable.name
      given.set(variable, variable.aside && map.has(variable) ? map.get(variable).name : own)
    }
    const wrong = [...misread(a, given)]
    if (wrong.length === 0) return given
    const yielding = wrong.some((variable) => weak.has(variable) && map.has(variable)) ? wrong.filter((variable) => weak.has(variable)) : wrong
    const dropped = yielding.filter((variable) => map.delete(variable))
    if (dropped.length === 0) return null
  }
}

function renamedNames(before, after, { extension = 'js', otherExtension = extension }) {
  const a = analyze(before, extension), b = analyze(after, otherExtension)
  if (a.reason || b.reason) return { reason: a.reason ?? b.reason }
  checkAnalysis(before, a)
  checkAnalysis(after, b)
  const paired = pairing(before, after, a, b)
  checkPairing(a, b, paired)
  const given = givenNames(a, b, paired)
  if (!given) return { reason: 'unverified' }
  checkGiven(a, b, paired.map, given)
  let at = 0, text = ''
  for (const [node, variable] of a.occurrences) {
    text += before.slice(at, node.start) + given.get(variable)
    at = node.end
  }
  text += before.slice(at)
  holds(before !== after || text === before, 'a text renamed as itself changed')
  checkRenamed(a, given, text, extension)
  if (!bindsAlike(before, text, a)) return { reason: 'unverified' }
  let renamed = 0, separated = 0
  for (const variable of a.variables) {
    if (given.get(variable) === variable.name) continue
    if (paired.map.has(variable)) renamed++
    else separated++
  }
  const reads = [...new Set([...a.reads, ...b.reads])].toSorted()
  return { text, renamed, apart: separated, kind: { module: a.module, commonjs: a.commonjs, own: a.own }, reads }
}

// Any failure, a check's or anything else's, gives no names and tells what
// failed: a mistake here shows a file with its names, never with names it
// does not have. oxc is had first, outside: one missing is thrown.
export function renameMap(before, after, options = {}) {
  getOxc()
  try {
    return renamedNames(before, after, options)
  } catch (err) {
    return { reason: 'unverified', invariant: err instanceof Broken ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}` }
  }
}

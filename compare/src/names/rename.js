// The old side of a file minified on both sides given the new side's names:
// both analyzed, variables paired by their lines, the names given checked not
// to read wrongly, and the result checked again by oxc (bindsAlike).

import { getOxc } from '#oxc'
import { analyze, minifiedTopLevel, ownTopLevel } from './analyze.js'
import { bindsAlike } from './binds.js'
import { checkAnalysis, checkGiven, checkPairing, checkRenamed } from './check.js'
import { misread } from './misread.js'
import { pairing } from './pairing.js'
import { APART, Broken, holds } from './syntax.js'

// Each old variable's name: its counterpart's, else its own, or one apart where
// the new side has its own. Those misread yield, weak pairs first, else those
// fewest lines pair: a pair that a few lines alone say gives way to one most
// do. null where none can.
function givenNames(a, b, { map, support, weak }) {
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
    const paired = wrong.filter((variable) => map.has(variable))
    const least = paired.reduce((n, variable) => Math.min(n, support.get(variable)), Infinity)
    const yielding = paired.some((variable) => weak.has(variable)) ? paired.filter((variable) => weak.has(variable)) : paired.filter((variable) => support.get(variable) === least)
    if (yielding.filter((variable) => map.delete(variable)).length === 0) return null
  }
}

function renamedNames(before, after, { extension = 'js', otherExtension = extension }) {
  let a = analyze(before, extension), b = analyze(after, otherExtension)
  if (a.reason || b.reason) return { reason: a.reason ?? b.reason }
  // A file is a module by how it is loaded, which its versions share, more than
  // by its syntax: a bundle's chunk that one version exports from, the other not,
  // or that neither does, its top level renamed by a minifier as a module's is.
  // Where either version is one, a script's top level is its own too.
  if ([a, b].some((side) => side.module || minifiedTopLevel(side))) [a, b] = [ownTopLevel(a), ownTopLevel(b)]
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
  const changed = a.variables.filter((variable) => given.get(variable) !== variable.name)
  const renamed = changed.filter((variable) => paired.map.has(variable)).length
  // A read of names can act otherwise only where one is renamed, and `.name` reads a function's or
  // class's alone: one only where a name renamed is one's.
  const naming = changed.some((variable) => variable.naming || paired.map.get(variable)?.naming)
  const reads = changed.length === 0 ? [] : [...new Set([...a.reads, ...b.reads])].filter((read) => read !== 'name' || naming).toSorted()
  return { text, renamed, apart: changed.length - renamed, kind: { module: a.module, commonjs: a.commonjs, own: a.own }, reads }
}

// Any failure gives no names, and tells what failed. oxc is loaded first, out
// of the try: one missing is thrown, not taken for a text it could not read.
export function renameMap(before, after, options = {}) {
  getOxc()
  try {
    return renamedNames(before, after, options)
  } catch (error) {
    return { reason: 'unverified', invariant: error instanceof Broken ? error.message : String(error) }
  }
}

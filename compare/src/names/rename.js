// The old side of a file minified on both sides given the new side's names:
// both analyzed, variables paired by their lines, the names given checked not
// to read wrongly, and the result checked again by oxc (bindsAlike).

import { getOxc } from '#oxc'
import { analyze } from './analyze.js'
import { bindsAlike } from './binds.js'
import { checkAnalysis, checkGiven, checkPairing, checkRenamed } from './check.js'
import { misread } from './misread.js'
import { pairing } from './pairing.js'
import { APART, Broken, holds } from './syntax.js'

// Each old variable's name: its counterpart's, else its own, or one apart where
// the new side has its own. Those misread yield, weak pairs first; null where
// none can.
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
    if (yielding.filter((variable) => map.delete(variable)).length === 0) return null
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
  const changed = a.variables.filter((variable) => given.get(variable) !== variable.name)
  const renamed = changed.filter((variable) => paired.map.has(variable)).length
  // `.name` reads a function's or class's name alone: one only where a name renamed is one's.
  const naming = changed.some((variable) => variable.naming || paired.map.get(variable)?.naming)
  const reads = [...new Set([...a.reads, ...b.reads])].filter((read) => read !== 'name' || naming).toSorted()
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

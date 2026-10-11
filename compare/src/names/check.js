// Checks that should never fail, standing between the steps of renaming: each
// throws a Broken naming what failed, and renameMap then gives no names.

import { analyze } from './analyze.js'
import { APART, IDENTIFIER, MINIFIED, RESERVED, holds } from './syntax.js'

// A text's analysis checked to hang together: each name it would rename
// written as that name where it is, read once and in order, none both a
// variable's and a global's, each variable declared and read by its own name,
// standing in its scopes by that name.
export function checkAnalysis(text, { scopes, variables, occurrences, globals }) {
  const known = new Set(variables), read = new Set()
  let end = 0
  for (const [node, variable] of occurrences) {
    holds(known.has(variable), `${node.name} at ${node.start} read as a variable none declares`)
    holds(node.name === variable.name, `${node.name} at ${node.start} read as ${variable.name}`)
    holds(node.start >= end && node.end > node.start, `${node.name} at ${node.start} out of order`)
    holds(text.slice(node.start, node.end) === node.name, `${node.name} at ${node.start} written otherwise`)
    end = node.end
    read.add(node.start)
  }
  for (const [node] of globals) holds(!read.has(node.start), `${node.name} at ${node.start} both a variable's and a global's`)
  const standing = new Set(occurrences.map(([, variable]) => variable))
  for (const variable of variables) holds(standing.has(variable), `${variable.name} read nowhere`)
  for (const at of scopes) for (const [name, variable] of at.names) holds(known.has(variable) && variable.name === name, `a scope's ${name} no variable of its name`)
}

// Which old variable became which new one, checked: renamable variables
// alone, each new one taken once, the weak among those paired.
export function checkPairing(a, b, { map, weak }) {
  const news = new Set(b.variables), taken = new Set()
  for (const [variable, to] of map) {
    holds(variable.aside && to.aside && news.has(to), `${variable.name} paired with ${to.name}, the two not both renamable`)
    holds(!taken.has(to), `two variables paired with ${to.name}`)
    taken.add(to)
  }
  for (const variable of weak) holds(map.has(variable), `${variable.name} weak, and paired with none`)
}

// The names given, checked: each changed one a renamable variable's, a name a
// variable may have, and either its counterpart's or one apart no side holds.
export function checkGiven(a, b, map, given) {
  for (const variable of a.variables) {
    const name = given.get(variable)
    if (name === variable.name) continue
    holds(variable.aside, `${variable.name}, which keeps its name, named ${name}`)
    holds(IDENTIFIER.test(name) && MINIFIED.test(name) && !RESERVED.has(name), `${variable.name} named ${name}, which no variable may be`)
    holds(map.has(variable) ? map.get(variable).name === name : name.startsWith(variable.name + APART) && !a.names.has(name) && !b.names.has(name),
      `${variable.name} named ${name}, neither its counterpart's name nor one apart`)
  }
}

// The renamed text read again as the old one was: each name where it was,
// written as given, the names of one variable still one variable's and those
// of two still two's, and the same globals read.
export function checkRenamed(a, given, text, extension) {
  const r = analyze(text, extension)
  holds(!r.reason, `the renamed text read again: ${r.reason}`)
  checkAnalysis(text, r)
  holds(r.occurrences.length === a.occurrences.length && r.globals.length === a.globals.length && r.variables.length === a.variables.length,
    'the renamed text reads another number of names')
  const backward = new Map(), forward = new Map()
  a.occurrences.forEach(([, variable], i) => {
    const [node, other] = r.occurrences[i]
    holds(node.name === given.get(variable), `${variable.name} written ${node.name}, not ${given.get(variable)}`)
    holds((forward.get(variable) ?? other) === other && (backward.get(other) ?? variable) === variable, `${variable.name}'s names read as another variable's`)
    forward.set(variable, other)
    backward.set(other, variable)
  })
  a.globals.forEach(([node], i) => holds(r.globals[i][0].name === node.name, `the global ${node.name} read as ${r.globals[i][0].name}`))
}

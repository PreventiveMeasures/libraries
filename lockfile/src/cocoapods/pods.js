// The strings PODS and DEPENDENCIES are made of, as Specification#to_s and
// Dependency#to_s write them: `Name (version)` for a pod; `Name` or
// `Name (requirements)` for a dependency, and of the Podfile's, `Name (from
// ...)` for one of an external source, which sources.js reads.

import { LockfileError, quote } from '../error.js'

// A name's segments, `/` between a root's and its subspecs': printable
// ASCII but for spaces, parentheses, slashes and backslashes, and no `.`
// first, which the spec linter refuses of a root. A space would read as
// the end of the name, and a parenthesis as its version.
const SEGMENT = /^(?!\.)[!-'*-.0-[\]-~]+$/u

export const rootOf = (name) => name.split('/')[0]

function checkPodName(name, where) {
  if (!name.split('/').every((segment) => SEGMENT.test(segment))) throw new LockfileError(`${quote(name)} is not a pod's name`, where)
  return name
}

export function checkRootName(name, where) {
  if (checkPodName(name, where).includes('/')) throw new LockfileError(`${quote(name)} is a subspec's name, where a root's is`, where)
  return name
}

// Pod::Version's pattern, once: CocoaPods takes it repeated, and with
// spaces around, none of which a version is written with.
const VERSION = /^\d+(?:\.[\dA-Za-z-]+)*(?:\+[\dA-Za-z.-]+)?$/u

const isVersion = (version) => VERSION.test(version)

// `Name (version)`, as PODS lists a pod.
export function readPodString(text, where) {
  const m = /^(\S+) \((.+)\)$/u.exec(text)
  if (m === null) throw new LockfileError(`${quote(text)} is not a pod and its version, as CocoaPods writes them`, where)
  if (!isVersion(m[2])) throw new LockfileError(`${quote(m[2])} is not a version`, where)
  return { name: checkPodName(m[1], where), version: m[2] }
}

const OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', '~>'])

// Each `operator version`, as Gem::Requirement#as_list writes them: sorted,
// and not `>= 0` alone, which is every version, and written as nothing.
function readRequirements(text, where) {
  const requirements = text.split(', ')
  for (const [index, requirement] of requirements.entries()) {
    const [operator, version, ...rest] = requirement.split(' ')
    if (!OPERATORS.has(operator) || version === undefined || !isVersion(version) || rest.length > 0) {
      throw new LockfileError(`${quote(requirement)} is not a requirement, as CocoaPods writes one`, where)
    }
    if (index > 0 && requirements[index - 1] > requirement) throw new LockfileError(`${quote(requirement)} after ${quote(requirements[index - 1])}, where CocoaPods sorts requirements`, where)
  }
  if (text === '>= 0') throw new LockfileError('">= 0", which CocoaPods writes as no requirement at all', where)
  return requirements
}

// `Name` or `Name (requirements)`; of the Podfile's, `Name (from ...)` too,
// with what follows `from`, for external.js to hold to the external source.
export function readPodfileDependency(text, where) {
  const m = /^(\S+)(?: \((.+)\))?$/u.exec(text)
  if (m === null) throw new LockfileError(`${quote(text)} is not a dependency, as CocoaPods writes one`, where)
  const name = checkPodName(m[1], where)
  if (m[2]?.startsWith('from `')) return { name, requirements: [], description: m[2] }
  return { name, requirements: m[2] === undefined ? [] : readRequirements(m[2], where), description: undefined }
}

// A podspec's dependency, which names no external source.
export function readDependency(text, where) {
  const { name, requirements, description } = readPodfileDependency(text, where)
  if (description !== undefined) throw new LockfileError(`${quote(text)} names an external source, which only the Podfile's dependencies do`, where)
  return { name, requirements }
}

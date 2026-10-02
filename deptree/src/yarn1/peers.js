// yarn 1's resolvePeerModules (package-linker.js), run before it hoists: a
// peer is looked for along the shortest chain of names the package was asked
// for by, and the nearest in range added; where none is, yarn only warns.

import { compareVersions, valid, validRange } from '@preventive/upstream/semver.js'

// yarn's util/semver.js: semver's prerelease rule ignored, and `<x` with no
// prerelease read as `<x-0`, so `<2.0.0` takes no 2.0.0-rc.1.
const OPERATORS = /^(<=|>=|<|>|=)?(.*)$/u

export function satisfiesWithPrereleases(version, range, loose = false) {
  const options = { loose }
  const normalized = validRange(range, options)
  if (normalized === null || !version || valid(version, options) === null) return false
  return normalized.split('||').some((set) => set.split(' ').every((comparator) => {
    const [, operator = '=', bound] = OPERATORS.exec(comparator)
    if (bound === '' || bound === '*') return true
    const order = compareVersions(version, operator === '<' && !bound.includes('-') ? `${bound}-0` : bound, options)
    return { '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0, '=': order === 0 }[operator]
  }))
}

export function resolvePeers(resolved, manifests) {
  const { patterns, byName } = resolved
  for (const [ref, manifest] of manifests) {
    const peers = manifest?.peerDependencies
    if (!peers) continue
    const chain = ref.requests.map((request) => request.parentNames ?? []).sort((a, b) => a.length - b.length)[0]
    const distance = (other) => {
      let min = Infinity
      for (const request of other.requests) {
        const names = request.parentNames ?? []
        const d = chain.length - names.length
        if (d >= 0 && d < min && names.every((name, i) => name === chain[i])) min = d
      }
      return min
    }
    for (const [name, range] of Object.entries(peers)) {
      let best = Infinity
      let found
      for (const candidate of new Set((byName.get(name) ?? []).map((pattern) => patterns.get(pattern)))) {
        const d = distance(candidate)
        if (d < best && (range === '*' || satisfiesWithPrereleases(candidate.version, range, true))) {
          best = d
          found = candidate
        }
      }
      if (found !== undefined) ref.asked.push(...found.patterns.map((pattern) => ({ pattern, optional: false, dev: false })))
    }
  }
}

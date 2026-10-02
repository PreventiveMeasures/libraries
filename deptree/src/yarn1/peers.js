// yarn 1's resolvePeerModules (package-linker.js), run before it hoists:
// each peer is looked for along the shortest chain of names the package was
// requested by, and the nearest version there that takes the peer's range
// is added to what it asks for, by all of that version's patterns, as
// neither dev nor optional. Where none is found, nothing is added, and yarn
// warns.

import { compareVersions, valid, validRange } from '@preventive/upstream/semver.js'

// yarn's satisfiesWithPrereleases (util/semver.js): each comparator of the
// range as semver normalizes it tested on its own, with no say of semver's
// over prereleases, and a `<` with no prerelease of its own read as `<` its
// lowest one, so that `<2.0.0` takes no 2.0.0-rc.1.
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

// `manifests` maps each reference to its package.json, in the order
// resolve.js's patterns name them.
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
        if (Number.isFinite(d) && d < best && (range === '*' || satisfiesWithPrereleases(candidate.version, range, true))) {
          best = d
          found = candidate
        }
      }
      if (found !== undefined) ref.asked.push(...found.patterns.map((pattern) => ({ pattern, optional: false, dev: false })))
    }
  }
}

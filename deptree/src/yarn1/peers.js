// yarn 1's resolvePeerModules (package-linker.js), run before it hoists:
// each package's peers are looked for along the shortest chain of names it
// was requested by, and the nearest version found there that takes the
// peer's range is added to its dependencies, by all of that version's
// patterns. Where none is found, nothing is added, and yarn warns.

// yarn's satisfiesWithPrereleases (util/semver.js): an upper bound
// excludes its own prereleases.
export function satisfiesWithPrereleases(semver, version, range, loose = false) {
  let parsed
  try {
    parsed = new semver.Range(range, loose)
  } catch {
    return false
  }
  if (!version) return false
  let actual
  try {
    actual = new semver.SemVer(version, parsed.loose)
  } catch {
    return false
  }
  // A `<` with no prerelease of its own made a `<` its lowest prerelease.
  const bounded = (comparator) => {
    if (comparator.operator !== '<' || !comparator.value || comparator.semver.prerelease.length > 0) return comparator
    comparator.semver.inc('pre', 0)
    return new semver.Comparator(comparator.operator + comparator.semver.version, comparator.loose)
  }
  return parsed.set.some((set) => set.every((comparator) => bounded(comparator).test(actual)))
}

// `resolved` is resolve.js's; `manifests` each reference's package.json,
// by reference, as fetched or as the workspace has it.
export function resolvePeers(resolved, manifests, semver) {
  const { patterns, byName } = resolved
  const seen = new Set()
  for (const ref of patterns.values()) {
    if (seen.has(ref)) continue
    seen.add(ref)
    const manifest = manifests.get(ref)
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
        if (Number.isFinite(d) && d < best && (range === '*' || satisfiesWithPrereleases(semver, candidate.version, range, true))) {
          best = d
          found = candidate
        }
      }
      if (found !== undefined) ref.dependencies.push(...found.patterns)
    }
  }
}

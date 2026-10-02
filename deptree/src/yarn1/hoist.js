// yarn 1's PackageHoister (package-hoister.js), ported as it is, quirks and
// all: each package is seeded beneath what asked for it, a level at a time,
// and hoisted as high as nothing of its name in the way, and no key
// reserved for another, lets it go. A prepass first seeds at the top, of
// several versions of a package, the one most others depend on. A level's
// requests are sorted by pattern, then those with peers, which a check
// meant to put them after their peers always puts last.
//
// It departs from yarn only in leaving out nohoist, --focus and --flat,
// which are refused before it runs, and yarn's record of each step; in
// comparing references' `loc` where yarn compares where its cache keeps two
// packages, and references where it compares manifests; and in reachedBut,
// its own.

// yarn's sortAlpha: by UTF-16 code units, as `<` compares strings.
const sortAlpha = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

const implode = (parts) => parts.join('#')

// `patterns` is resolve.js's, each pattern to its reference; `peersOf`
// gives a reference's peers' names, from its package.json.
export class Hoister {
  constructor(patterns, peersOf) {
    this.patterns = patterns
    this.peersOf = peersOf
    this.tainted = new Map()
    this.levelQueue = []
    this.tree = new Map()
  }

  resolved(pattern) {
    const ref = this.patterns.get(pattern)
    if (ref === undefined) throw new Error(`no package for ${pattern}`)
    return ref
  }

  // A key reserved for a package, unless it is for another already.
  taintKey(key, info) {
    const existing = this.tainted.get(key)
    if (!existing || existing.ref.loc === info.ref.loc) this.tainted.set(key, info)
  }

  // resolver.dedupePatterns: the first pattern of each package.
  dedupe(patterns) {
    return [...Map.groupBy(patterns, (pattern) => this.resolved(pattern)).values()].map(([first]) => first)
  }

  seed(patterns) {
    this.prepass(patterns)
    for (const pattern of this.dedupe(patterns)) this.seedOne(pattern, { isDirectRequire: true })
    while (this.levelQueue.length > 0) {
      let queue = this.levelQueue.sort(([a], [b]) => sortAlpha(a, b))
      this.levelQueue = []
      const sorted = []
      const available = new Set()
      let changed = true
      while (queue.length > 0 && changed) {
        changed = false
        const copy = queue
        queue = []
        for (const item of copy) {
          const [pattern] = item
          if (this.peersOf(this.resolved(pattern)).every((peer) => available.has(peer))) {
            sorted.push(item)
            available.add(pattern)
            changed = true
          } else queue.push(item)
        }
      }
      for (const [pattern, parent] of sorted.concat(queue)) {
        const info = this.seedOne(pattern, { isDirectRequire: false, parent })
        if (info) this.hoist(info)
      }
    }
    this.propagateRequired()
  }

  seedOne(pattern, { isDirectRequire, parent }) {
    const ref = this.resolved(pattern)
    if (parent && !this.tree.get(parent.key)) return null
    const isIncompatible = ref.incompatible === true
    const isRequired = !isIncompatible && (isDirectRequire || parent?.isRequired === true)
    // A key is the names from the top down to the package, joined by `#`.
    const parts = (parent?.parts ?? []).concat(ref.name)
    const key = implode(parts)
    const info = { key, parts, ref, isDirectRequire, isRequired, isIncompatible }
    this.tree.set(key, info)
    this.taintKey(key, info)
    for (const dependency of new Set(ref.dependencies)) this.levelQueue.push([dependency, info])
    return info
  }

  propagateRequired() {
    const toVisit = [...this.tree.values()].filter((info) => info.isRequired)
    // In yarn's order, but by index, as shift() copies a long array.
    for (let i = 0; i < toVisit.length; i++) {
      const info = toVisit[i]
      for (const dependency of info.ref.dependencies) {
        const found = this.lookupDependency(info, dependency)
        if (found && !found.isRequired && !found.isIncompatible) {
          found.isRequired = true
          toVisit.push(found)
        }
      }
    }
  }

  // Not yarn's: the places reached from `asked`, as topRequests has it,
  // through what each package asks for, its peers among that, by requests
  // whose `kind`, `dev` or `optional`, is not set; each found as
  // propagateRequired finds it, past none the host cannot run. Every other
  // place is reached by dev, or optional, dependencies alone.
  reachedBut(kind, asked) {
    const queue = [{ parts: [], ref: { asked } }]
    const reached = new Set()
    while (queue.length > 0) {
      const info = queue.pop()
      for (const dep of info.ref.asked) {
        if (dep[kind]) continue
        const found = this.lookupDependency(info, dep.pattern)
        if (found === null || found.isIncompatible || reached.has(found)) continue
        reached.add(found)
        queue.push(found)
      }
    }
    return reached
  }

  lookupDependency(info, pattern) {
    const ref = this.resolved(pattern)
    for (let i = info.parts.length; i >= 0; i--) {
      const existing = this.tree.get(implode(info.parts.slice(0, i).concat(ref.name)))
      if (existing) return existing
    }
    return null
  }

  newParts(key, info, parts) {
    let stepUp = false
    const stack = []
    const name = parts.pop()
    for (let i = parts.length - 1; i >= 0; i--) {
      const checkParts = parts.slice(0, i).concat(name)
      const existing = this.tree.get(implode(checkParts))
      if (existing) {
        if (existing.ref.loc === info.ref.loc) {
          if (!existing.isRequired && info.isRequired) existing.isRequired = true
          return { parts: checkParts, duplicate: true }
        }
        break
      }
      const taint = this.tainted.get(implode(checkParts))
      if (taint && taint.ref.loc !== info.ref.loc) break
    }
    const peers = this.peersOf(info.ref)
    while (parts.length > 0 && !peers.some((peer) => this.tree.get(implode(parts.concat(peer))))) {
      const checkKey = implode(parts.concat(name))
      if (this.tree.get(checkKey) || (key !== checkKey && this.tainted.has(checkKey))) {
        stepUp = true
        break
      }
      stack.push(parts.pop())
    }
    parts.push(name)
    const isValidPosition = (candidate) => {
      const candidateKey = implode(candidate)
      if (this.tree.get(candidateKey)?.ref.loc === info.ref.loc) return true
      const taint = this.tainted.get(candidateKey)
      return !taint || taint.ref.loc === info.ref.loc
    }
    if (!isValidPosition(parts)) stepUp = true
    while (stepUp && stack.length > 0) {
      parts.pop()
      parts.push(stack.pop(), name)
      if (isValidPosition(parts)) stepUp = false
    }
    return { parts, duplicate: false }
  }

  hoist(info) {
    const { key: oldKey, parts: rawParts } = info
    this.tree.delete(oldKey)
    const { parts, duplicate } = this.newParts(oldKey, info, rawParts.slice())
    const newKey = implode(parts)
    // yarn's declareRename: each key it passed over reserved for it.
    if (duplicate || newKey !== oldKey) {
      for (let i = parts.length - 1; i < rawParts.length - 1; i++) this.taintKey(implode(rawParts.slice(0, i).concat(info.ref.name)), info)
    }
    if (duplicate) return
    info.key = newKey
    info.parts = parts
    this.tree.set(newKey, info)
  }

  prepass(rawPatterns) {
    const patterns = this.dedupe(rawPatterns).sort()
    const visited = new Map()
    const occurrences = Object.create(null)
    const visitAdd = (ref, ancestry, pattern) => {
      const versions = (occurrences[ref.name] ??= Object.create(null))
      const version = (versions[ref.version] ??= { occurrences: new Set(), pattern })
      if (ancestry.length > 0) version.occurrences.add(ancestry.at(-1))
    }
    const add = (pattern, ancestry, ancestryPatterns) => {
      const ref = this.resolved(pattern)
      if (ancestry.includes(ref)) return
      let visitedPattern = visited.get(pattern)
      if (visitedPattern) {
        for (const visit of visitedPattern) visitAdd(visit.ref, visit.ancestry, visit.pattern)
        visitAdd(ref, ancestry, pattern)
        return
      }
      visitAdd(ref, ancestry, pattern)
      for (const dependency of ref.dependencies) add(dependency, ancestry.concat(ref), ancestryPatterns.concat(dependency))
      visitedPattern = visited.get(pattern) ?? []
      visited.set(pattern, visitedPattern)
      visitedPattern.push({ ref, ancestry, pattern })
      for (const ancestryPattern of ancestryPatterns) visited.get(ancestryPattern)?.push({ ref, ancestry, pattern })
    }
    const rootNames = new Set()
    for (const pattern of patterns) {
      rootNames.add(this.resolved(pattern).name)
      add(pattern, [], [])
    }
    for (const name of Object.keys(occurrences).sort()) {
      const versions = occurrences[name]
      if (Object.keys(versions).length === 1 || this.tree.get(name) || rootNames.has(name)) continue
      let mostCount
      let mostPattern
      for (const version of Object.keys(versions).sort()) {
        const { occurrences: occurred, pattern } = versions[version]
        if (!mostCount || occurred.size > mostCount) {
          mostCount = occurred.size
          mostPattern = pattern
        }
      }
      if (mostCount > 1) this.seedOne(mostPattern, { isDirectRequire: false })
    }
  }

  // Each required package by its names from the top down, but, as in yarn,
  // not `aggregator`, if given, nor what stayed directly beneath it.
  flatten(aggregator) {
    const flat = []
    for (const [key, info] of this.tree) {
      if (!info.isRequired) continue
      const names = key.split('#')
      if (aggregator !== undefined && names[0] === aggregator && names.length <= 2) continue
      flat.push({ names, info })
    }
    return flat
  }
}

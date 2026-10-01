// yarn 1's PackageHoister (package-hoister.js), as it lays out a
// node_modules tree: each package seeded beneath what asked for it, a
// level at a time, and hoisted as high as nothing of its name in the way,
// and no name reserved by another, lets it go. A prepass first seeds at
// the top the version of a package that the most others depend on, where
// several versions are asked for. The order is yarn's, quirks and all:
// a level's requests sorted by pattern, then those with peers, which a
// check meant to put them after their peers always puts last.
//
// Ported as it is, but for what is refused before it runs: nohoist,
// --focus and --flat; and the record yarn keeps of each step. Where yarn
// compares where its cache keeps two packages, this compares their
// references' `loc`; where it compares two manifests, the references.

// A package where the tree has it: by its key, the names from the top
// down to it joined by `#`.
const placed = (key, parts, ref, isDirectRequire, isRequired, isIncompatible) => ({ key, parts, ref, isDirectRequire, isRequired, isIncompatible })

// yarn's sortAlpha: by UTF-16 code units, then by length.
export function sortAlpha(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length - b.length
}

const implode = (parts) => parts.join('#')

// `patterns` resolve.js's, each pattern to its reference; `peersOf` a
// reference's peers' names, from its package.json.
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
    const seen = new Set()
    return patterns.filter((pattern) => {
      const ref = this.resolved(pattern)
      if (seen.has(ref)) return false
      seen.add(ref)
      return true
    })
  }

  seed(patterns) {
    this.prepass(patterns)
    for (const pattern of this.dedupe(patterns)) this.seedOne(pattern, { isDirectRequire: true })
    while (true) {
      let queue = this.levelQueue
      if (queue.length === 0) {
        this.propagateRequired()
        return
      }
      this.levelQueue = []
      queue = queue.sort(([a], [b]) => sortAlpha(a, b))
      let sorted = []
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
      sorted = sorted.concat(queue)
      for (const [pattern, parent] of sorted) {
        const info = this.seedOne(pattern, { isDirectRequire: false, parent })
        if (info) this.hoist(info)
      }
    }
  }

  seedOne(pattern, { isDirectRequire, parent }) {
    const ref = this.resolved(pattern)
    let parentParts = []
    const isIncompatible = ref.incompatible
    let isRequired = isDirectRequire && !ref.ignore && !isIncompatible
    if (parent) {
      if (!this.tree.get(parent.key)) return null
      if (!isDirectRequire && !isIncompatible && parent.isRequired) isRequired = true
      parentParts = parent.parts
    }
    const parts = parentParts.concat(ref.name)
    const key = implode(parts)
    const info = placed(key, parts, ref, isDirectRequire, isRequired, isIncompatible)
    this.tree.set(key, info)
    this.taintKey(key, info)
    const pushed = new Set()
    for (const dependency of ref.dependencies) {
      if (!pushed.has(dependency)) {
        this.levelQueue.push([dependency, info])
        pushed.add(dependency)
      }
    }
    return info
  }

  propagateRequired() {
    const toVisit = [...this.tree.values()].filter((info) => info.isRequired)
    while (toVisit.length > 0) {
      const info = toVisit.shift()
      for (const dependency of info.ref.dependencies) {
        const found = this.lookupDependency(info, dependency)
        if (found && !found.isRequired && !found.isIncompatible) {
          found.isRequired = true
          toVisit.push(found)
        }
      }
    }
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
    const fullKey = implode(parts)
    const stack = []
    const name = parts.pop()
    for (let i = parts.length - 1; i >= 0; i--) {
      const checkParts = parts.slice(0, i).concat(name)
      const existing = this.tree.get(implode(checkParts))
      if (existing) {
        if (existing.ref.loc === info.ref.loc) {
          if (!existing.isRequired && info.isRequired) existing.isRequired = true
          return { parts: checkParts, duplicate: true, fullKey }
        }
        break
      }
      const taint = this.tainted.get(implode(checkParts))
      if (taint && taint.ref.loc !== info.ref.loc) break
    }
    const peers = this.peersOf(info.ref)
    hoistLoop: while (parts.length > 0) {
      for (const peer of peers) {
        if (this.tree.get(implode(parts.concat(peer)))) break hoistLoop
      }
      const checkKey = implode(parts.concat(name))
      if (this.tree.get(checkKey)) {
        stepUp = true
        break
      }
      if (key !== checkKey && this.tainted.has(checkKey)) {
        stepUp = true
        break
      }
      stack.push(parts.pop())
    }
    parts.push(name)
    const isValidPosition = (candidate) => {
      if (candidate.length <= 0) return false
      const candidateKey = implode(candidate)
      const existing = this.tree.get(candidateKey)
      if (existing && existing.ref.loc === info.ref.loc) return true
      const taint = this.tainted.get(candidateKey)
      return !(taint && taint.ref.loc !== info.ref.loc)
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
    if (duplicate) {
      this.taintParents(info, rawParts.slice(0, -1), parts.length - 1)
      return
    }
    if (oldKey === newKey) {
      this.setKey(info, oldKey, rawParts)
      return
    }
    this.taintParents(info, rawParts.slice(0, -1), parts.length - 1)
    this.setKey(info, newKey, parts)
  }

  taintParents(info, processParts, start) {
    for (let i = start; i < processParts.length; i++) this.taintKey(implode(processParts.slice(0, i).concat(info.ref.name)), info)
  }

  setKey(info, newKey, parts) {
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

  // The tree, flat: each package required, by the names from the top down
  // to it; one yarn leaves to the aggregator, its workspaces' own place,
  // with them. `aggregator` the aggregator's name, if any.
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

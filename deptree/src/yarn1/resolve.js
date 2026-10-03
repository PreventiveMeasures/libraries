// yarn 1's resolver (package-resolver.js, package-request.js) on a frozen
// lockfile. Which request makes a reference, and so whose names its requests
// carry, turns on yarn's order: top-level requests run one after another.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { matchesGlob } from '../glob.js'

// Beneath a top-level request, all run at once, each taking these microtask
// turns, by its resolver, before it checks for a package of its version.
const TURNS = { registry: 5, workspace: 3 }

// yarn's normalizePattern.
export function splitPattern(pattern) {
  const scoped = pattern.startsWith('@')
  const [name, ...parts] = (scoped ? pattern.slice(1) : pattern).split('@')
  const version = parts.join('@')
  return { name: scoped ? `@${name}` : name, range: parts.length === 0 ? 'latest' : version || '*', hasVersion: version !== '' }
}

// yarn's normalizeRange: any range but a semver range or one with a `:`,
// such as an `npm:` alias, is a tag.
const TAG = /^[\w~-][\w.~-]*$/u
function kindOf(range, where) {
  if (validRange(range)) return 'range'
  if (range.startsWith('npm:')) return 'alias'
  if (TAG.test(range) && !/\.(?:tgz|tar\.gz)$/u.test(range)) return 'tag'
  throw new DeptreeError('only a semver range, an npm: alias or a tag is supported', where)
}

// What a package asks for, in yarn's order. A lockfile entry's are patterns;
// one the lockfile reader links to a workspace has lost its range.
function asked(info, where) {
  const workspace = info.kind === 'workspace'
  const lists = workspace ? info.workspace.manifest : info.entry
  const kinds = [['dependencies', false, false], ['optionalDependencies', true, false], ...workspace ? [['devDependencies', false, true]] : []]
  return kinds.flatMap(([kind, optional, dev]) => Object.entries(lists[kind] ?? {}).map(([name, value]) => {
    if (!workspace && value.startsWith('link:')) throw new DeptreeError(`its dependency on ${quote(name)} is a workspace, which is not supported`, where)
    return { pattern: workspace ? `${name}@${value}` : value, optional, dev }
  }))
}

// Where yarn's cache keeps a package (generateModuleCachePath), which is
// what its hoister tells two references apart by: two of one package, as
// a tag or an alias asked for twice makes, are one there.
function locOf({ kind, name, version, entry }) {
  if (kind === 'workspace') return `workspace\n${name}`
  const { uid } = entry
  const { sha1, integrity } = entry.resolution ?? {}
  return `npm\n${name}\n${version}\n${uid !== undefined && uid !== version ? uid : sha1 ?? ''}\n${integrity ? 'integrity' : ''}`
}

class Resolver {
  constructor({ lockfile, workspaces, rules, isDirectory }) {
    Object.assign(this, { lockfile, workspaces, rules, isDirectory })
    this.patterns = new Map()
    this.byName = new Map()
    this.delayed = []
    this.diverted = []
  }

  addPattern(pattern, ref) {
    ref.patterns.push(pattern)
    this.patterns.set(pattern, ref)
    if (!this.byName.has(ref.name)) this.byName.set(ref.name, [])
    const list = this.byName.get(ref.name)
    if (!list.includes(pattern)) list.push(pattern)
  }

  // isLockfileEntryOutdated: yarn resolves anew an entry out of its pattern's
  // range, which --frozen-lockfile fails on only at the top level.
  infoOf(request) {
    const { name, range, hasVersion } = splitPattern(request.pattern)
    const workspace = this.workspaces.get(name)
    if (workspace !== undefined && satisfies(workspace.version, range, { loose: true })) return { kind: 'workspace', name: workspace.name, version: workspace.version, workspace }
    const where = quote(request.pattern)
    const tag = kindOf(range, where) === 'tag'
    const entry = this.lockfile.packages[request.pattern]
    if (entry === undefined) throw new DeptreeError('yarn would resolve this pattern anew: the lockfile has no entry for it', where)
    if (hasVersion && validRange(range) && !satisfies(entry.version, range)) {
      throw new DeptreeError(`yarn would resolve this pattern anew: the lockfile has ${entry.version}, which the range does not take`, where)
    }
    return { kind: 'registry', name, version: entry.version, entry, tag }
  }

  // No resolution applies to a top-level request.
  ruleOf({ pattern, parentNames }) {
    if (parentNames === undefined) return undefined
    const { name } = splitPattern(pattern)
    const path = [...parentNames, name].join('/')
    return this.rules.find((rule) => rule.name === name && matchesGlob(rule.glob, path))
  }

  exactMatch(name, version) {
    return this.byName.get(name)?.map((pattern) => this.patterns.get(pattern)).find((ref) => ref.version === version)
  }

  // Waits where a package of its name and version is resolved already; else
  // makes the reference and hands back its own requests. A tag or an alias
  // never finds one, so each request of one makes a reference of its own,
  // the last of which its pattern names.
  check(request, info) {
    const { name, range } = splitPattern(request.pattern)
    if (this.exactMatch(name, validRange(range) ? info.version : range) !== undefined) {
      this.delayed.push(request)
      return []
    }
    const ref = {
      name: info.name,
      version: info.version,
      loc: locOf(info),
      kind: info.kind,
      entry: info.entry,
      workspace: info.workspace,
      patterns: [],
      requests: [request],
      asked: asked(info, quote(request.pattern)),
      optional: request.optional,
    }
    this.addPattern(request.pattern, ref)
    const parentNames = [...request.parentNames ?? [], name]
    return ref.asked.map((dep) => ({ pattern: dep.pattern, parentNames, optional: dep.optional || (!dep.dev && request.optional) }))
  }

  divert(request, rule) {
    const target = this.patterns.get(rule.pattern)
    if (target === undefined) throw new DeptreeError(`the resolution ${quote(rule.path)} applies to it, and yarn never resolves ${quote(rule.pattern)}`, quote(request.pattern))
    this.addPattern(request.pattern, target)
  }

  // Given the resolution's package where one applies, or else timed for its
  // check; a tag's request waits, never counting down, for answer().
  start(request) {
    const rule = this.ruleOf(request)
    if (rule !== undefined) {
      if (this.patterns.has(rule.pattern)) this.divert(request, rule)
      else this.diverted.push([request, rule])
      return undefined
    }
    const info = this.infoOf(request)
    return { request, info, left: info.tag ? Infinity : TURNS[info.kind] }
  }

  answer(waiting) {
    if (waiting.length > 1) throw new DeptreeError(`yarn resolves these in the order the filesystem answers it, which is not set: ${waiting.map(({ request }) => quote(request.pattern)).join(', ')}`)
    const [strand] = waiting
    const where = quote(strand.request.pattern)
    const { range } = splitPattern(strand.request.pattern)
    const found = this.isDirectory(range)
    if (found === undefined) throw new DeptreeError(`yarn installs the directory ${quote(range)} for it where the project has one, which is known only with the project read`, where)
    if (found) throw new DeptreeError(`yarn installs the directory ${quote(range)} for it, which is not supported`, where)
    strand.left = 1
    return [strand]
  }

  // A microtask turn: the requests a check makes start where it stood.
  turn(strands) {
    const next = []
    for (const strand of strands) {
      if (--strand.left > 0) next.push(strand)
      else next.push(...this.check(strand.request, strand.info).map((child) => this.start(child)).filter(Boolean))
    }
    return next
  }

  run(request) {
    let strands = [this.start(request)].filter(Boolean)
    while (strands.length > 0) {
      if (strands.every((strand) => strand.left === Infinity)) strands = this.answer(strands)
      strands = this.turn(strands)
    }
  }

  // yarn's resolveToExistingVersion for the delayed, then the diverted.
  settle() {
    for (const request of this.delayed) {
      const { name } = splitPattern(request.pattern)
      const ref = this.exactMatch(name, this.infoOf(request).version)
      ref.requests.push(request)
      this.addPattern(request.pattern, ref)
      if (!request.optional) ref.optional = false
    }
    for (const [request, rule] of this.diverted) this.divert(request, rule)
  }
}

export function resolve({ top, ...options }) {
  const resolver = new Resolver(options)
  for (const request of top) resolver.run(request)
  resolver.settle()
  return { patterns: resolver.patterns, byName: resolver.byName }
}

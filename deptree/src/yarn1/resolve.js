// What yarn 1's resolver makes of a lockfile it installs frozen
// (package-resolver.js, package-request.js): a reference for each package,
// with the requests that led to it and the patterns that name it, and its
// dependencies as the patterns it asks for. Which request makes a package's
// reference, and so whose names its own requests carry, turns on the order
// yarn resolves requests in, which this follows as yarn runs them:
//
//  - the top-level requests one after another, each with all it leads to
//    before the next: resolutions' patterns, then the root's dependencies,
//    devDependencies and optionalDependencies, then the workspace
//    aggregator, then the workspaces the root does not depend on;
//  - beneath one, every request at once, each taking as many turns of the
//    microtask queue as its resolver does before it checks for a package
//    of its name and version already resolved, by its resolver, as
//    TURNS has them; one that finds none makes
//    the reference and starts its own requests, in its place in the queue;
//    one that finds one waits, and is added to it once all are resolved;
//  - a request a resolution applies to is given the resolution's package,
//    as no request at all, or once all are resolved, where the
//    resolution's own pattern is not yet;
//  - a request of a tag first asks the filesystem whether the tag is a
//    directory of the project, which yarn would install instead, and so
//    waits for every other request to be done: one alone is checked then,
//    and two at once, which the filesystem answers in no set order, are
//    refused.
//
// A range that is no semver range, a dist-tag or an `npm:` alias, never
// finds a package of its version, so each request of one makes a reference
// of its own, the last of which its pattern names.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { matchesGlob } from './glob.js'

// The turns of the microtask queue a request takes before its check, by
// its resolver.
const TURNS = { registry: 5, workspace: 3 }

// yarn's normalizePattern.
export function splitPattern(pattern) {
  const scoped = pattern.startsWith('@')
  const parts = (scoped ? pattern.slice(1) : pattern).split('@')
  let name = parts.shift()
  let range = 'latest'
  const hasVersion = parts.length > 0 && parts.join('@') !== ''
  if (parts.length > 0) range = parts.join('@') || '*'
  if (scoped) name = `@${name}`
  return { name, range, hasVersion }
}

// How yarn's registry resolver reads a range before it looks the pattern
// up (normalizeRange): a semver range, and one with a `:`, an `npm:` alias
// among them, as it is; a tag, any other, as a directory first. One that
// names another source, a URL, a path or a git host, goes to another of
// yarn's resolvers, which are not followed; it is refused, as is any other
// with a `:` or an `@`, and a tag that is not a plain name.
const TAG = /^[\w~-][\w.~-]*$/u
function kindOf(range, where) {
  if (validRange(range)) return 'range'
  if (range.startsWith('npm:')) return 'alias'
  if (TAG.test(range) && !/\.(?:tgz|tar\.gz)$/u.test(range)) return 'tag'
  throw new DeptreeError('only a semver range, an npm: alias or a tag is supported', where)
}

// What a request's package asks for, as yarn asks, in its order: its
// dependencies, then its optional ones, then, a workspace's, its dev ones;
// each by its pattern, `name@range`, optional or not, dev or not. A
// lockfile entry's are the lockfile reader's targets, which are their
// patterns; one it links to a workspace has lost its range, and is
// refused.
function asked(info, where) {
  const workspace = info.kind === 'workspace'
  const lists = workspace ? info.workspace.manifest : info.entry
  const kinds = [['dependencies', false, false], ['optionalDependencies', true, false], ...workspace ? [['devDependencies', false, true]] : []]
  const out = []
  for (const [kind, optional, dev] of kinds) {
    for (const [name, value] of Object.entries(lists[kind] ?? {})) {
      if (!workspace && value.startsWith('link:')) throw new DeptreeError(`its dependency on ${quote(name)} is a workspace, which is not supported`, where)
      out.push({ pattern: workspace ? `${name}@${value}` : value, optional, dev })
    }
  }
  return out
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

// The requests yarn resolves, and what they make of the lockfile.
class Resolver {
  constructor({ lockfile, workspaces, rules, isDirectory }) {
    Object.assign(this, { lockfile, workspaces, rules, isDirectory })
    this.patterns = new Map()
    this.byName = new Map()
    this.delayed = []
    this.diverted = []
  }

  addPattern(pattern, ref) {
    this.patterns.set(pattern, ref)
    if (!this.byName.has(ref.name)) this.byName.set(ref.name, [])
    const list = this.byName.get(ref.name)
    if (!list.includes(pattern)) list.push(pattern)
  }

  // The workspace a pattern names, where its version is in the range.
  workspaceOf(pattern) {
    const { name, range } = splitPattern(pattern)
    const workspace = this.workspaces.get(name)
    return workspace !== undefined && satisfies(workspace.version, range, { loose: true }) ? workspace : undefined
  }

  // What a request finds before it checks: a workspace's manifest, or the
  // lockfile's entry for the pattern. yarn drops an entry whose version a
  // semver range of its pattern does not take (isLockfileEntryOutdated),
  // and resolves the pattern anew, which --frozen-lockfile fails on only
  // for a top-level one.
  infoOf(request) {
    const workspace = this.workspaceOf(request.pattern)
    if (workspace !== undefined) return { kind: 'workspace', name: workspace.name, version: workspace.version, workspace }
    const where = quote(request.pattern)
    const { name, range, hasVersion } = splitPattern(request.pattern)
    const tag = kindOf(range, where) === 'tag'
    const entry = this.lockfile.packages[request.pattern]
    if (entry === undefined) throw new DeptreeError('yarn would resolve this pattern anew: the lockfile has no entry for it', where)
    if (hasVersion && validRange(range) && !satisfies(entry.version, range)) {
      throw new DeptreeError(`yarn would resolve this pattern anew: the lockfile has ${entry.version}, which the range does not take`, where)
    }
    return { kind: 'registry', name, version: entry.version, entry, tag }
  }

  // The resolution that applies to a request, by its path; undefined
  // where none does, or for a top-level request.
  ruleOf({ pattern, parentNames }) {
    if (parentNames === undefined) return undefined
    const { name } = splitPattern(pattern)
    const path = [...parentNames, name].join('/')
    return this.rules.find((rule) => rule.name === name && matchesGlob(rule.glob, path))
  }

  exactMatch(name, version) {
    for (const pattern of this.byName.get(name) ?? []) {
      const ref = this.patterns.get(pattern)
      if (ref.version === version) return ref
    }
    return undefined
  }

  // A request's check: given the package of its name and version, or made
  // the reference, its own requests handed back.
  check(request, info) {
    const { name, range } = splitPattern(request.pattern)
    const solved = validRange(range) ? info.version : range
    if (this.exactMatch(name, solved) !== undefined) {
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
      patterns: [request.pattern],
      requests: [request],
      dependencies: [],
      optional: request.optional,
    }
    this.addPattern(request.pattern, ref)
    const parentNames = [...request.parentNames ?? [], name]
    const children = []
    for (const dep of asked(info, quote(request.pattern))) {
      ref.dependencies.push(dep.pattern)
      children.push({ pattern: dep.pattern, parentNames, optional: dep.optional || (!dep.dev && request.optional) })
    }
    return children
  }

  // A request a resolution applies to, given the resolution's package.
  divert(request, rule) {
    const target = this.patterns.get(rule.pattern)
    if (target === undefined) throw new DeptreeError(`the resolution ${quote(rule.path)} applies to it, and yarn never resolves ${quote(rule.pattern)}`, quote(request.pattern))
    target.patterns.push(request.pattern)
    this.addPattern(request.pattern, target)
  }

  // A request about to start: given the resolution's package where one
  // applies, or else timed for its check. Where yarn has not resolved the
  // resolution's own pattern yet, the request waits until all else is.
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

  // The one request of a tag left waiting, once every other is done, let
  // on to its check; refused where the tag is a directory, or might be.
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

  // A turn of the microtask queue: each request whose turn it is checked,
  // the requests it makes started where it stood.
  turn(strands) {
    const next = []
    for (const strand of strands) {
      if (--strand.left > 0) next.push(strand)
      else next.push(...this.check(strand.request, strand.info).map((child) => this.start(child)).filter(Boolean))
    }
    return next
  }

  // A top-level request, and all it leads to.
  run(request) {
    let strands = [this.start(request)].filter(Boolean)
    while (strands.length > 0) {
      if (strands.every((strand) => strand.left === Infinity)) strands = this.answer(strands)
      strands = this.turn(strands)
    }
  }

  // resolveToExistingVersion: each waiting request, in turn, added to the
  // package of its version; then each a resolution applies to that waited.
  settle() {
    for (const request of this.delayed) {
      const { name } = splitPattern(request.pattern)
      const ref = this.exactMatch(name, this.infoOf(request).version)
      ref.requests.push(request)
      ref.patterns.push(request.pattern)
      this.addPattern(request.pattern, ref)
      if (ref.optional === null || ref.optional === undefined) ref.optional = request.optional
      else if (!request.optional) ref.optional = false
    }
    for (const [request, rule] of this.diverted) this.divert(request, rule)
  }
}

// `lockfile` as @preventive/lockfile's parseYarn1Lockfile reads it;
// `workspaces` by name, in the order yarn finds them, each with its
// directory, cleaned version and manifest, the aggregator among them;
// `rules` the root's resolutions; `top` the top-level requests in order;
// `isDirectory(tag)` whether the project has a `<tag>/package.json`, or
// undefined where that is not known.
export function resolve({ top, ...options }) {
  const resolver = new Resolver(options)
  for (const request of top) resolver.run(request)
  resolver.settle()
  const { patterns, byName } = resolver
  return { patterns, byName }
}

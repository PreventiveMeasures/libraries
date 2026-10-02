// yarn's resolution-map.js. yarn gives what a resolution resolves to to any
// request of that name and version: each must be one the resolution matches.

import { LockfileError, at, quote } from '../error.js'
import { KINDS } from '../graph.js'
import { orEmpty } from '../shape.js'
import { accepts, close, step } from '../glob.js'
import { WHERE } from './importers.js'
import { checkLists } from './packages.js'

// yarn asks for a workspace's dependencies via `workspace-aggregator-<uuid>`.
const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'

// Each request, on each path yarn may make it by, leads where the first rule
// to match resolves it. Hands back the patterns asked for as they are.
function checkApplied(packages, { importers, workspaces, rules, aggregated }, explained) {
  const tests = rules.map((rule) => rule.tests)
  const consume = (masks, name) => name.split('/').reduce((states, segment) => states.map((mask, i) => step(tests[i], mask, segment)), masks)
  const lead = (target) => (target.startsWith('link:') ? importers[target.slice(5)] : packages[target])
  const refuse = (node, kind, alias, detail) => {
    const place = node.patterns === undefined ? at(WHERE, Object.keys(importers).find((dir) => importers[dir] === node)) : at('', node.patterns[0])
    return new LockfileError(`${quote(node[kind][alias])} ${detail}`, at(at(place, kind), alias))
  }
  const seen = new Map()
  const queue = []
  const plain = new Set()
  const rewritten = new Map()
  // yarn writes one entry for a pattern, so cannot give it one thing where
  // a rule rewrites it to another pattern and another where none does.
  const mark = (node, kind, alias, rule) => {
    const target = node[kind][alias]
    const unwritten = rule === undefined || rule.pattern === target
    const other = unwritten ? rewritten.get(target) : plain.has(target) ? rule : undefined
    if (other !== undefined) throw refuse(node, kind, alias, `is asked for both where the resolution ${quote(other.path)} applies and where none does, and yarn writes one entry for both`)
    if (unwritten) plain.add(target)
    else rewritten.set(target, rule)
  }
  // yarn reads a package's dependencies once, from the first request of it
  // it resolves, and none from a request a rule rewrites.
  let first = new Set()
  const enqueue = (node, masks) => {
    if (first.has(node)) return
    const states = seen.get(node) ?? new Set()
    const id = masks.join()
    if (states.has(id)) return
    seen.set(node, states.add(id))
    queue.push([node, masks])
  }
  const root = importers['.']
  const initial = tests.map((item) => close(item, 1))
  const aggregator = consume(initial, AGGREGATOR)
  const own = new Map()
  const linked = []
  // A rule gives its pattern's entry, or one standing in for a workspace.
  const gives = (rule, entry) => packages[rule.target] === entry || explained.get(entry)?.sources[0] === rule.target
  const request = (node, kind, alias, masks) => {
    const target = node[kind][alias]
    const next = consume(masks, alias)
    const entry = packages[target]
    const mixed = explained.get(entry)
    const by = mixed === undefined ? '' : `the resolution ${quote(mixed.rule.path)} resolves to`
    // A workspace root's own, but for a workspace's name, are asked for again
    // through the aggregator, where resolutions apply, and the last wins.
    const direct = node === root && (!aggregated || workspaces.has(alias))
    const path = node === root && !direct ? consume(aggregator, alias) : next
    const rule = rules.find((item, i) => item.name === alias && accepts(tests[i], path[i]))
    if (direct) {
      // yarn applies no resolution to the root's own, nor says so where one
      // would apply, and installs the two by the order it resolves them in.
      if (mixed !== undefined) throw refuse(node, kind, alias, `is given what ${by}, which yarn applies to no dependency of the root's own`)
      if (rule !== undefined && !gives(rule, entry)) throw refuse(node, kind, alias, `is not given ${quote(rule.pattern)} as the resolution ${quote(rule.path)} says, which yarn ignores for the root's own dependencies`)
      mark(node, kind, alias, undefined)
      return enqueue(lead(target), next)
    }
    if (rule !== undefined && !gives(rule, entry)) throw refuse(node, kind, alias, `is not given ${quote(rule.pattern)}, which the resolution ${quote(rule.path)} resolves it to`)
    if (mixed?.sources.includes(target)) throw refuse(node, kind, alias, `asks for what ${by}, as a dependency of its own`)
    if (mixed !== undefined && !mixed.sources.includes(rule?.target)) throw refuse(node, kind, alias, `is given what ${by}, which yarn does not apply to it here`)
    mark(node, kind, alias, rule)
    if (node === root && rule !== undefined) own.set(target, rule)
    if (rule === undefined) enqueue(lead(target), next)
    else if (rule.target.startsWith('link:')) linked.push([node[kind], alias, rule.target])
  }
  const drain = () => {
    while (queue.length > 0) {
      const [node, masks] = queue.pop()
      for (const kind of KINDS) for (const alias of Object.keys(orEmpty(node[kind]))) request(node, kind, alias, masks)
    }
  }
  // yarn resolves each resolution's own pattern from the root first.
  for (const item of rules) {
    if (!(item.pattern in packages)) continue
    plain.add(item.pattern)
    enqueue(packages[item.pattern], consume(initial, item.name))
  }
  drain()
  first = new Set(seen.keys())
  for (const kind of KINDS) for (const alias of Object.keys(root[kind])) request(root, kind, alias, initial)
  for (const [name, { dir }] of workspaces) enqueue(importers[dir], consume(aggregator, name))
  drain()
  for (const [targets, alias, target] of linked) targets[alias] = target
  return { plain, own }
}

// yarn takes an entry whose version a range of it does not satisfy as
// outdated, where no resolution applies, or where it asks before one does.
function checkRanges(packages, patterns, applied, semver, manifests) {
  for (const { key, range, source, alias } of patterns) {
    const rule = applied?.own.get(key)
    if (source !== 'registry' || (rule === undefined && applied?.plain.has(key) === false)) continue
    const wanted = alias?.range ?? range
    const { version } = packages[key]
    if (wanted === '' || semver.satisfies(version, wanted) || semver.validRange(wanted) === null) continue
    let why = manifests ? 'and no resolution gives it' : 'which only a resolution may excuse, as the manifests would say'
    if (rule !== undefined) why = `which the root asks for before the resolution ${quote(rule.path)} applies, so yarn takes it as outdated`
    throw new LockfileError(`${version} does not satisfy ${quote(wanted)}, ${why}`, at('', key))
  }
}

// yarn writes a request a resolution gives a workspace as an entry of the
// workspace's version and dependencies, resolving nothing, but links it.
function standsIn(pkg, project, where) {
  const workspace = project?.workspaces.get(pkg.name)
  if (workspace === undefined) return undefined
  const rule = project.rules.find((item) => item.target === `link:${workspace.dir}`)
  if (rule === undefined) return undefined
  const of = `than the workspace ${quote(workspace.dir)}, which the resolution ${quote(rule.path)} gives it`
  if (pkg.version !== workspace.version) throw new LockfileError(`another version ${of}, ${workspace.version}`, at(where, 'version'))
  // Both read as requests are, a workspace's linked.
  checkLists(pkg, project.importers[workspace.dir], of, where)
  return rule
}

// `project` is undefined without manifests: no resolution explains an entry.
export function checkResolutions({ packages, patterns, mixed }, project, semver) {
  const explained = new Map()
  for (const { pkg, registry, sources, other } of mixed) {
    const where = at('', pkg.patterns[0])
    if (sources.length === 0) {
      const rule = standsIn(pkg, project, where)
      if (rule === undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and resolves to nothing, ${project === undefined ? 'which only a resolution to a workspace may, as the manifests would say' : 'as for a directory'}`, where)
      explained.set(pkg, { sources: [rule.target], rule })
      continue
    }
    if (project === undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(sources[0])} names, which only a resolution may, as the manifests would say`, where)
    const unnamed = sources.find((source) => !project.rules.some((rule) => rule.pattern === source))
    if (unnamed !== undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(unnamed)} names, which no resolution does`, where)
    const rule = project.rules.find((item) => sources.includes(item.pattern))
    if (other !== undefined) throw new LockfileError(`asks for what the resolution ${quote(rule.path)} resolves to, as a dependency of its own`, at('', other.patterns[0]))
    explained.set(pkg, { sources, rule })
  }
  const applied = project !== undefined && project.rules.length > 0 ? checkApplied(packages, project, explained) : undefined
  if (semver !== undefined) checkRanges(packages, patterns, applied, semver, project !== undefined)
  for (const [pkg, { sources }] of explained) if (sources[0].startsWith('link:')) delete packages[pkg.patterns[0]]
}

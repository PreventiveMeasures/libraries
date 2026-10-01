// yarn's resolution-map.js. yarn gives what a resolution resolves to to any
// request of that name and version: each must be one the resolution matches.

import { LockfileError, at, quote } from '../error.js'
import { EMPTY } from '../shape.js'
import { accepts, close, compile, step } from './glob.js'
import { KINDS, WHERE } from './importers.js'
import { fetchedFrom } from './packages.js'

// yarn asks for a workspace's dependencies via `workspace-aggregator-<uuid>`.
const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'

// Each request, along each path yarn may make it by, leads where the first
// rule to match resolves it; the root's own requests have no path.
function checkApplied(packages, { importers, workspaces, rules }, explained) {
  const tests = rules.map((rule) => compile(rule.glob, rule.where))
  const consume = (masks, name) => name.split('/').reduce((states, segment) => states.map((mask, i) => step(tests[i], mask, segment)), masks)
  const lead = (target) => (target.startsWith('link:') ? importers[target.slice(5)] : packages[target])
  const refuse = (node, kind, alias, detail) => {
    const place = node.patterns === undefined ? at(WHERE, Object.keys(importers).find((dir) => importers[dir] === node)) : at('', node.patterns[0])
    return new LockfileError(`${quote(node[kind][alias])} ${detail}`, at(at(place, kind), alias))
  }
  const seen = new Map()
  const queue = []
  const enqueue = (node, masks) => {
    const states = seen.get(node) ?? new Set()
    if (states.has(masks.join())) return
    seen.set(node, states.add(masks.join()))
    queue.push([node, masks])
  }
  const root = importers['.']
  const request = (node, kind, alias, masks) => {
    const target = node[kind][alias]
    const next = consume(masks, alias)
    const entry = packages[target]
    const mixed = explained.get(entry)
    const by = mixed === undefined ? '' : `the resolution ${quote(mixed.rule.path)} resolves to`
    if (node === root) {
      if (mixed !== undefined) throw refuse(node, kind, alias, `is given what ${by}, which yarn applies to no dependency of the root's own`)
      return enqueue(lead(target), next)
    }
    const rule = rules.find((item, i) => item.name === alias && accepts(tests[i], next[i]))
    if (rule !== undefined && packages[rule.pattern] !== entry) throw refuse(node, kind, alias, `is not given ${quote(rule.pattern)}, which the resolution ${quote(rule.path)} resolves it to`)
    if (mixed?.sources.includes(target)) throw refuse(node, kind, alias, `asks for what ${by}, as a dependency of its own`)
    if (mixed !== undefined && !mixed.sources.includes(rule?.pattern)) throw refuse(node, kind, alias, `is given what ${by}, which yarn does not apply to it here`)
    return enqueue(lead(target), next)
  }
  const initial = tests.map((item) => close(item, 1))
  for (const kind of KINDS) for (const alias of Object.keys(root[kind])) request(root, kind, alias, initial)
  for (const [name, dir] of workspaces) enqueue(importers[dir], consume(consume(initial, AGGREGATOR), name))
  // yarn resolves each resolution's own pattern from the root too.
  for (const item of rules) if (item.pattern in packages) enqueue(packages[item.pattern], consume(initial, item.name))
  while (queue.length > 0) {
    const [node, masks] = queue.pop()
    for (const kind of KINDS) for (const alias of Object.keys(node[kind] ?? EMPTY)) request(node, kind, alias, masks)
  }
}

// `project` is undefined without manifests: no resolution explains an entry.
export function checkResolutions(mixed, packages, project) {
  const explained = new Map()
  for (const { pkg, registry, sources } of mixed) {
    const where = at('', pkg.patterns[0])
    if (project === undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(sources[0])} names, which only a resolution may, as the manifests would say`, where)
    const unnamed = sources.find((source) => !project.rules.some((rule) => rule.pattern === source))
    if (unnamed !== undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(unnamed)} names, which no resolution does`, where)
    const rule = project.rules.find((item) => sources.includes(item.pattern))
    const source = fetchedFrom(pkg.resolution)
    const other = source === undefined ? undefined : Object.values(packages).find((item) => item !== pkg && fetchedFrom(item.resolution) === source)
    if (other !== undefined) throw new LockfileError(`asks for what the resolution ${quote(rule.path)} resolves to, as a dependency of its own`, at('', other.patterns[0]))
    explained.set(pkg, { sources, rule })
  }
  if (project !== undefined && project.rules.length > 0) checkApplied(packages, project, explained)
}

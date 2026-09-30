// Resolutions as yarn applies them (its resolution-map.js). The root
// manifest's `"path/name": "range"` resolves a request for `name` whose
// path, the names it is requested through and its own, matches `path` as
// minimatch reads it; the first to match does, and a path of a name alone
// is `**/name`. A dependency of the root manifest's own has no path and is
// resolved by none. A workspace's is requested through yarn's workspace
// aggregator, and through the root or another workspace that asks for it.
//
// yarn also resolves a resolution's own pattern, from the root, and gives
// what that resolves to to any request of the same name and version, one
// the resolution applies to or not. So a resolution to a tarball, a
// directory or a repository shares its entry with patterns that ask for
// the registry, and the lockfile cannot say whether each was resolved or
// only given it. Such an entry is read where every request of its patterns
// is one the resolution applies to. One that is not, the root's own, a
// dependency on what the resolution names, or another entry of the same
// tarball, is refused, as the package installed there is not the one
// asked for; and without the manifests, every such entry is.

import { LockfileError, at, quote } from '../error.js'
import { EMPTY } from '../shape.js'
import { KINDS, WHERE } from './importers.js'

// What yarn names its aggregator, `workspace-aggregator-` and a UUID that
// no glob but a wildcard matches.
const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'

const WILD = { '*': '[^/]*', '?': '[^/]' }

// A glob as minimatch reads it, a segment of a path at a time: null for
// `**`, and otherwise a test of one segment, where `*` is any run of
// characters and `?` any one. The rest of what minimatch reads is not.
function compile({ glob, path, where }) {
  const segments = glob.split('/')
  if (segments.length > 30 || segments.some((segment) => segment === '' || /[[\]{}()!+\\]/u.test(segment))) {
    throw new LockfileError(`${quote(path)} is a glob not read here`, where)
  }
  return segments.map((segment) => (segment === '**' ? null : new RegExp(`^${segment.replaceAll(/[$.*?^|]/gu, (char) => WILD[char] ?? `\\${char}`)}$`, 'u')))
}

// The states of a glob as a mask, a bit for each segment matched so far:
// past `**`, the next segment may match as well.
function close(tests, mask) {
  let closed = mask
  for (let i = 0; i < tests.length; i++) if ((closed & (1 << i)) !== 0 && tests[i] === null) closed |= 1 << (i + 1)
  return closed
}

function step(tests, mask, segment) {
  let next = 0
  for (let i = 0; i < tests.length; i++) {
    if ((mask & (1 << i)) === 0) continue
    if (tests[i] === null) next |= 1 << i
    else if (tests[i].test(segment)) next |= 1 << (i + 1)
  }
  return close(tests, next)
}

// Where yarn fetches a package from, as one string: a tarball, `./` or
// not, or a repository at a commit.
function fetchedFrom(resolution) {
  if (resolution === undefined) return undefined
  return resolution.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution.tarball.replace(/^file:\.\//u, 'file:')
}

// Every request of the patterns of `entry`, along every path yarn may
// request it by, is one a resolution to one of `sources` applies to. A
// node is a package or a project, and asks for others by kind.
function checkApplied(entry, sources, rule, packages, { importers, workspaces, rules }) {
  const own = rules.filter((item) => item.name === entry.name).map((item) => ({ pattern: item.pattern, tests: compile(item) }))
  const consume = (masks, name) => name.split('/').reduce((states, segment) => states.map((mask, i) => step(own[i].tests, mask, segment)), masks)
  const lead = (target) => (target.startsWith('link:') ? importers[target.slice(5)] : packages[target])
  const by = `the resolution ${quote(rule.path)} resolves to`
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
  // A request of `node` along the path `masks` is at; one of the root's own
  // has none, and is resolved by nothing.
  const root = importers['.']
  const request = (node, kind, alias, masks) => {
    const target = node[kind][alias]
    const next = consume(masks, alias)
    if (packages[target] === entry) {
      if (node === root) throw refuse(node, kind, alias, `is given what ${by}, which yarn applies to no dependency of the root's own`)
      if (sources.includes(target)) throw refuse(node, kind, alias, `asks for what ${by}, as a dependency of its own`)
      const first = own.find((item, i) => (next[i] & (1 << item.tests.length)) !== 0)
      if (!sources.includes(first?.pattern)) throw refuse(node, kind, alias, `is given what ${by}, which yarn does not apply to it here`)
    }
    enqueue(lead(target), next)
  }
  const initial = own.map((item) => close(item.tests, 1))
  for (const kind of KINDS) for (const alias of Object.keys(root[kind])) request(root, kind, alias, initial)
  for (const [name, dir] of workspaces) enqueue(importers[dir], consume(consume(initial, AGGREGATOR), name))
  for (const item of rules) if (item.pattern in packages) enqueue(packages[item.pattern], consume(initial, item.name))
  while (queue.length > 0) {
    const [node, masks] = queue.pop()
    for (const kind of KINDS) for (const alias of Object.keys(node[kind] ?? EMPTY)) request(node, kind, alias, masks)
  }
}

// `mixed`: the entries packages.js hands over, each giving a pattern that
// asks for the registry what its `sources` name. `project`: what
// importers.js reads of the manifests, undefined where there are none.
export function checkResolutions(mixed, packages, project) {
  for (const { pkg, registry, sources } of mixed) {
    const where = at('', pkg.patterns[0])
    if (project === undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(sources[0])} names, which only a resolution may, as the manifests would say`, where)
    const unnamed = sources.find((source) => !project.rules.some((rule) => rule.pattern === source))
    if (unnamed !== undefined) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(unnamed)} names, which no resolution does`, where)
    const rule = project.rules.find((item) => sources.includes(item.pattern))
    const source = fetchedFrom(pkg.resolution)
    const other = source === undefined ? undefined : Object.values(packages).find((item) => item !== pkg && fetchedFrom(item.resolution) === source)
    if (other !== undefined) throw new LockfileError(`asks for what the resolution ${quote(rule.path)} resolves to, as a dependency of its own`, at('', other.patterns[0]))
    checkApplied(pkg, sources, rule, packages, project)
  }
}

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
// asked for.

import { LockfileError, at, quote } from '../error.js'
import { checkName } from '../names.js'
import { EMPTY, entries, string } from '../shape.js'

// What yarn names its aggregator, `workspace-aggregator-` and a UUID that
// no glob but a wildcard matches.
const AGGREGATOR = 'workspace-aggregator-00000000-0000-0000-0000-000000000000'
const WHERE = 'manifests'

// yarn's parsePackagePath and parsePatternInfo; a path that ends in `/` or
// `*` or has `//` in it is ignored, as yarn does.
export function readResolutions(value, where) {
  const rules = []
  for (const [path, range, here] of entries(value ?? EMPTY, where)) {
    if (/\/$|\/{2,}|\*+$/u.test(path)) continue
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = checkName(names.at(-1), here)
    rules.push({ path, glob: names.length === 1 ? `**/${path}` : path, name, pattern: `${name}@${string(range, here)}`, where: here })
  }
  return rules
}

// A glob as minimatch reads it, a segment of a path at a time: null for
// `**`, and otherwise a test of one segment, where `*` is any run of
// characters and `?` any one. The rest of what minimatch reads is not.
function compile({ glob, path, where }) {
  const segments = glob.split('/')
  if (segments.length > 30 || segments.some((segment) => segment === '' || /[[\]{}()!+\\]/u.test(segment))) {
    throw new LockfileError(`${quote(path)} is a glob not read here`, where)
  }
  const wild = { '*': '[^/]*', '?': '[^/]' }
  return segments.map((segment) => (segment === '**' ? null : new RegExp(`^${segment.replaceAll(/[$.*?^|]/gu, (char) => wild[char] ?? `\\${char}`)}$`, 'u')))
}

// The states of a glob as a mask, a bit for each segment matched so far:
// past `**`, the next segment may match as well.
function close(glob, mask) {
  let closed = mask
  for (let i = 0; i < glob.length; i++) if ((closed & (1 << i)) !== 0 && glob[i] === null) closed |= 1 << (i + 1)
  return closed
}

function step(glob, mask, segment) {
  let next = 0
  for (let i = 0; i < glob.length; i++) {
    if ((mask & (1 << i)) === 0) continue
    if (glob[i] === null) next |= 1 << i
    else if (glob[i].test(segment)) next |= 1 << (i + 1)
  }
  return close(glob, next)
}

// Tarballs and repositories as yarn fetches them, `./` or not.
function sourceOf(resolution) {
  if (resolution === undefined) return undefined
  return resolution.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution.tarball.replace(/^file:\.\//u, 'file:')
}

// What a package's entry or a project asks for, each with where it is.
function* requests(node, importers) {
  const [owner, where] = typeof node === 'string' ? [importers[node], at(WHERE, node)] : [node, at('', node.patterns[0])]
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [alias, target] of Object.entries(owner[kind] ?? EMPTY)) yield [alias, target, at(at(where, kind), alias)]
  }
}

// Every request of the patterns of `entry`, along every path yarn may
// request it by, is one a resolution to one of `sources` applies to.
function checkApplied(entry, sources, rules, manifests, importers, packages) {
  const own = rules.filter((rule) => rule.name === entry.name).map((rule) => ({ ...rule, glob: compile(rule) }))
  const rule = own.find((item) => sources.includes(item.pattern))
  const consume = (masks, name) => name.split('/').reduce((states, segment) => states.map((mask, i) => step(own[i].glob, mask, segment)), masks)
  const initial = own.map((item) => close(item.glob, 1))
  const queue = []
  const seen = new Set()
  const enqueue = (node, masks) => {
    const key = `${typeof node === 'string' ? `link:${node}` : node.patterns[0]}\n${masks.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    queue.push([node, masks])
  }
  const lead = (target) => (target.startsWith('link:') ? target.slice(5) : packages[target])
  for (const [alias, target, where] of requests('.', importers)) {
    if (packages[target] === entry) throw new LockfileError(`${quote(target)} is given what the resolution ${quote(rule.path)} resolves to, which yarn applies to no dependency of the root's own`, where)
    enqueue(lead(target), consume(initial, alias))
  }
  for (const dir of Object.keys(importers)) if (dir !== '.') enqueue(dir, consume(consume(initial, AGGREGATOR), manifests[dir].name))
  for (const item of rules) if (item.pattern in packages) enqueue(packages[item.pattern], consume(initial, item.name))
  while (queue.length > 0) {
    const [node, masks] = queue.pop()
    for (const [alias, target, where] of requests(node, importers)) {
      const next = consume(masks, alias)
      if (packages[target] === entry) {
        if (sources.includes(target)) throw new LockfileError(`${quote(target)} asks for what the resolution ${quote(rule.path)} resolves to, as a dependency of its own`, where)
        const first = own.find((item, i) => (next[i] & (1 << item.glob.length)) !== 0)
        if (!sources.includes(first?.pattern)) throw new LockfileError(`${quote(target)} is given what the resolution ${quote(rule.path)} resolves to, which yarn does not apply to it here`, where)
      }
      enqueue(lead(target), next)
    }
  }
}

// `mixed`: the entries packages.js hands over, each giving a pattern that
// asks for the registry what `sources` name.
export function checkResolutions(mixed, rules, manifests, importers, packages) {
  for (const { pkg, registry, sources, where } of mixed) {
    for (const source of sources) {
      if (!rules.some((rule) => rule.pattern === source)) throw new LockfileError(`${quote(registry)} asks for the registry, and is given what ${quote(source)} names, which no resolution does`, where)
    }
    const shared = sourceOf(pkg.resolution)
    const rule = rules.find((item) => sources.includes(item.pattern))
    for (const other of new Set(Object.values(packages))) {
      if (other !== pkg && shared !== undefined && sourceOf(other.resolution) === shared) {
        throw new LockfileError(`asks for what the resolution ${quote(rule.path)} resolves to, as a dependency of its own`, at('', other.patterns[0]))
      }
    }
    checkApplied(pkg, sources, rules, manifests, importers, packages)
  }
}

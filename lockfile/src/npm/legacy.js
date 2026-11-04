// The tree again, as npm 6 reads one, which a package-lock.json of version
// 2 has beside `packages`, under `dependencies`: each package and link by
// its folder in the node_modules it is in, with what it asks for under
// `requires`, and what is in its node_modules, or in that of the
// directory a link leads to, under `dependencies` again. npm 7 and later
// read `packages` alone, and write the tree from it, as Shrinkwrap's
// buildLegacyLockfile does; it is held to that here, field by field, so
// that npm 6 reads the lockfile as npm 7 and later do.

import { LockfileError, at, placed, quote } from '../error.js'
import { relativeTo } from '../names.js'
import { kind, record } from '../shape.js'
import { inDepBundle } from './bundles.js'
import { FLAGS } from './entries.js'
import { checkFlags } from './flags.js'
import { readSpec } from './spec.js'
import { directoryOf, packageOf } from './tree.js'
import { isValid } from './valid.js'

const FIELDS = ['version', 'resolved', 'integrity', 'bundled', ...FLAGS, 'requires', 'dependencies', 'from']

const describe = (node) => (node.location === '' ? 'the project' : quote(node.location))

// npm 9 to 10.9.2 and 11.0.0 to 11.1.0 write a `#` in the path of a link
// and of a `file:` spec as `%23`.
function escapesHash(npm) {
  const [major, minor, patch] = npm.split('.').map(Number)
  return major === 9 || (major === 10 && (minor < 9 || (minor === 9 && patch <= 2))) || (major === 11 && minor < 2)
}

// The edges npm may write an entry by: of those met, those from a node in
// the fewest node_modules, and of them the first by the rest of its
// location, as string-locale-compare orders them: by Intl.Collator('en'),
// or where there is no Intl, by localeCompare, as this does either way. Of
// a tie npm takes the one it loaded first, in an order of its own, so any
// of them is taken.
function chosenEdges(node, semver) {
  let chosen = []
  let best
  for (const edge of node.edgesIn) {
    const parts = edge.from.location.split('node_modules')
    const key = [parts.length, parts.at(-1)]
    const order = best === undefined ? -1 : key[0] - best[0] || key[1].localeCompare(best[1], 'en')
    // One placed after the best met so far is not chosen, met or not.
    if (order > 0 || !isValid(edge, semver)) continue
    if (order < 0) [chosen, best] = [[edge], key]
    else chosen.push(edge)
  }
  return chosen
}

// A path, from the lockfile's directory, as npm saves it in a `file:` spec:
// path.relative from the directory `dir`.
function savedPath(dir, path) {
  const relative = relativeTo(dir, path)
  return `file:${relative === '.' ? '' : relative}`
}

// npm-package-arg's type of what an edge asks for, its saveSpec where it
// is a tarball, and the raw `name@spec` it writes as `from`. A path is
// written from the node that asks for it.
function specOf(node, edge) {
  const dir = directoryOf(edge.from)
  const requested = readSpec(node.folder, edge.spec, dir, undefined)
  const raw = `${node.folder}@${edge.spec}`
  if (requested.type === 'file') return { type: 'file', save: savedPath(dir, requested.path), raw }
  if (requested.type === 'remote') return { type: 'remote', save: requested.url, raw }
  return { type: requested.type, raw }
}

// What an entry says of where a package comes from, by the edge npm
// writes it by, or by its own resolved where no edge is met: a tarball
// by the spec, from a repository its resolved with what was asked for,
// else its version, under its own name for an alias, with the tarball
// from a URL beside it. A link names the directory it leads to.
function headOf(node, edge, escape) {
  if (node.kind === 'link') return { version: `file:${escape(node.target.location)}` }
  const { resolution } = node
  const resolved = resolution?.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution?.tarball
  let own
  if (resolution?.type === 'git') own = 'git'
  else if (resolved !== undefined) own = resolved.startsWith('file:') ? 'file' : 'remote'
  const spec = edge === undefined ? { type: own, save: resolved, raw: resolved } : specOf(node, edge)
  if (spec.type === 'file' || spec.type === 'remote') return { version: spec.save }
  if (spec.type === 'git' || own === 'git') return { version: resolved, from: spec.raw }
  const version = node.name === node.folder ? node.version : `npm:${node.name}@${node.version}`
  return { version, resolved: own === 'remote' ? resolved : undefined }
}

// Of each distinct head, one.
const distinct = (heads) => [...new Map(heads.map((head) => [JSON.stringify(head), head])).values()]

// A value as npm writes it of a node, or none where `expected` is
// undefined.
function expectValue(value, expected, where, node) {
  if (value === expected) return
  const written = expected === undefined ? 'none' : typeof expected === 'string' ? quote(expected) : String(expected)
  throw new LockfileError(`expected ${written}, found ${kind(value)}, as npm writes it of ${describe(node)}`, where)
}

const expect = (entry, key, expected, where, node) => expectValue(entry[key], expected, at(where, key), node)

// A `file:` spec as npm writes it under `requires`, from the directory
// that asks for it to where the spec leads from there. A path npm would
// write by where the project is, or the home directory, is refused.
function fileSpec(edge, dir, escape, where) {
  const { path } = placed(() => readSpec(edge.name, edge.spec, dir, undefined), where)
  return escape(savedPath(dir, path))
}

// What a node asks for, but peers, as npm writes it: none where it asks
// for nothing, peers either.
function requiresOf(node, escape, where) {
  if (node.edges.size === 0) return undefined
  const requires = Object.create(null)
  for (const edge of node.edges.values()) {
    if (edge.type.startsWith('peer')) continue
    requires[edge.name] = edge.spec.startsWith('file:') ? fileSpec(edge, directoryOf(node), escape, at(where, edge.name)) : edge.spec
  }
  return requires
}

function checkRequires(value, node, escape, where) {
  const expected = requiresOf(node, escape, where)
  if (expected === undefined) return expectValue(value, undefined, where, node)
  const written = record(value, where)
  for (const [name, spec] of Object.entries(written)) {
    if (!Object.hasOwn(expected, name)) throw new LockfileError(`${describe(node)} asks for no such package, or for a peer, which npm leaves out`, at(where, name))
    if (spec !== expected[name]) {
      throw new LockfileError(`expected ${quote(expected[name])}, as ${describe(node)} asks for it, found ${kind(spec)}, which npm writes there of an override alone, not read here`, at(where, name))
    }
  }
  const missing = Object.keys(expected).find((name) => !Object.hasOwn(written, name))
  if (missing !== undefined) throw new LockfileError(`expected ${quote(missing)}, which ${describe(node)} asks for`, where)
}

// The tree under `written`, as npm writes it: an entry of each node in the
// node_modules of `node`, but of a link to a directory the tree is in
// there already, of those `above` it.
function checkTree(written, node, where, above, context) {
  const kids = new Set([...node.children.values()].filter((kid) => !above.includes(packageOf(kid).location)))
  if (kids.size === 0) return expectValue(written, undefined, where, node)
  const path = [...above, node.location]
  const entries = written === undefined ? Object.create(null) : record(written, where)
  for (const [name, entry] of Object.entries(entries)) {
    const kid = node.children.get(name.toLowerCase())
    const location = `${node.location === '' ? '' : `${node.location}/`}node_modules/${name}`
    if (kid === undefined || kid.folder !== name) throw new LockfileError(`${quote(location)} is not in packages`, at(where, name))
    if (!kids.has(kid)) throw new LockfileError(`${quote(location)} links to ${quote(directoryOf(packageOf(kid)))}, which this is under already, and npm leaves it out`, at(where, name))
    checkEntry(entry, kid, at(where, name), path, context)
  }
  const missing = [...kids].find((kid) => !Object.hasOwn(entries, kid.folder))
  if (missing !== undefined) throw new LockfileError(`expected ${quote(missing.folder)}, as npm writes ${quote(missing.location)} of packages`, where)
}

// The tarball's URL, which npm, set to, leaves out of every entry: the
// first entry that has it, or not, says which, as `context` keeps.
function checkResolved(value, expected, where, node, context) {
  if (expected !== undefined && value === undefined) {
    if (context.resolved !== undefined) throw new LockfileError(`expected ${quote(expected)}: npm leaves it out of every entry or of none, and ${context.resolved} has it`, where)
    context.omitted ??= where
    return
  }
  expectValue(value, expected, where, node)
  if (value === undefined) return
  if (context.omitted !== undefined) throw new LockfileError(`expected none: npm leaves it out of every entry or of none, and ${context.omitted} has none`, where)
  context.resolved ??= where
}

// What an entry of a node says whatever entry it is under: the heads npm
// may write it by, and whether a tarball bundles it.
function ownOf(node, context) {
  const { semver, escape, own, root } = context
  if (!own.has(node)) {
    const edges = node.kind === 'link' ? [] : chosenEdges(node, semver)
    const heads = distinct(edges.length === 0 ? [headOf(node, undefined, escape)] : edges.map((edge) => headOf(node, edge, escape)))
    own.set(node, { heads, bundled: inDepBundle(node, root) || undefined })
  }
  return own.get(node)
}

function checkEntry(entry, node, where, path, context) {
  record(entry, where, FIELDS)
  const { heads, bundled } = ownOf(node, context)
  const head = heads.find(({ version, from }) => version === entry.version && from === entry.from) ?? heads[0]
  expect(entry, 'version', head.version, where, node)
  expect(entry, 'from', head.from, where, node)
  checkResolved(entry.resolved, head.resolved, at(where, 'resolved'), node, context)
  expect(entry, 'bundled', bundled, where, node)
  expect(entry, 'integrity', node.resolution?.integrity, where, node)
  for (const flag of FLAGS) expect(entry, flag, node.flags?.[flag] || undefined, where, node)
  const target = packageOf(node)
  checkRequires(entry.requires, target, context.escape, at(where, 'requires'))
  checkTree(entry.dependencies, target, at(where, 'dependencies'), path, context)
}

// The tree, `#` in a path written as it is, or as `%23` where `escaped`;
// `seen.hash` set where a `#` is met, so the other way could read otherwise.
function check(written, nodes, semver, escaped, seen = {}) {
  const escape = (path) => {
    if (!path.includes('#')) return path
    seen.hash = true
    return escaped ? path.replaceAll('#', '%23') : path
  }
  const root = nodes.get('')
  checkTree(written, root, 'dependencies', [], { semver, escape, own: new Map(), root, omitted: undefined, resolved: undefined })
}

// One of the npms that write a `#` as `%23`, all of which set the flags as
// npm 9 does.
const ESCAPING = '9.0.0'

// The tree under `dependencies` of a lockfile of version 2, from the nodes
// as loaded and checked: as `npm` writes it, where given; else as one
// version of npm does, and where none, the refusal is the latest one's.
export function checkLegacy(written, nodes, semver, npm) {
  if (npm !== undefined) return check(written, nodes, semver, escapesHash(npm))
  const seen = { hash: false }
  try {
    check(written, nodes, semver, false, seen)
  } catch (error) {
    // The other way reads alike up to the first `#`, and so fails alike.
    if (!(error instanceof LockfileError) || !seen.hash) throw error
    try {
      check(written, nodes, semver, true)
    } catch {
      throw error
    }
    checkFlags(nodes, ESCAPING, 'an npm that writes a "#" as "%23"')
  }
}

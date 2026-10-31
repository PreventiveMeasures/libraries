// What npm ci holds the tree to before it installs it (Arborist's
// buildIdealTree from the lockfile): from the project, each dependency of
// each node it reaches, through links into the directories in the project,
// has to be met where npm looks for it, by what it asks for. One that is
// not, npm resolves again, and installs something the lockfile does not
// say; or, as `npm ci`, refuses. An optional peer `npm ci` takes as the
// lockfile has it, met or not, and what a package bundles is what its
// tarball has, though npm looks into it. A directory out of the project
// npm leaves to itself.

import { LockfileError, attempt, placed, quote } from '../error.js'
import { joinRelative } from '../names.js'
import { sshOf } from './hosted.js'
import { readResolved, readSpec } from './spec.js'
import { directoryOf, edgeAt, packageOf } from './tree.js'

const COMMIT = /^[\dA-Fa-f]{40,64}$/u

// fromPath: a package from a tarball on disk asks from the tarball's
// directory, any other node from its own.
function fromPath(node) {
  const tarball = node.resolution?.tarball
  return tarball?.startsWith('file:') ? joinRelative(tarball.slice(5), '..') : directoryOf(node)
}

const describe = (node) => quote(node.location)

// A version, a range or a tag of the registry: a version or a range by
// semver, where it is given; a tag where the package came from a URL, as
// one from the registry does. What is in the folder of the name is what
// npm takes, an alias among them.
function registryValid(child, { fetchSpec, kind }, semver) {
  const pkg = packageOf(child)
  if (kind === undefined || (kind === 'range' && fetchSpec === '*')) return undefined
  if (kind === 'tag') return child.kind === 'link' || !/^https?:/u.test(child.resolution?.tarball ?? '') ? `is a tag, which npm holds met by a tarball from a URL alone, and ${describe(child)} is none` : undefined
  return semver.satisfies(pkg.version ?? '', fetchSpec, true) ? undefined : `is not satisfied by ${describe(child)}, ${pkg.version ?? 'of no version'}`
}

// A repository, by the ssh URL of one on a host npm knows or else by its
// URL, at a commit where it names one, and in a range of versions.
function gitValid(child, requested, semver) {
  const { resolution, version } = child
  if (child.kind === 'link' || resolution?.type !== 'git') return `asks for a git repository, and ${describe(child)} is from none`
  const resolved = readResolved(`${resolution.repo}#${resolution.commit}`)
  const commit = COMMIT.test(requested.committish ?? '')
  const same = requested.hosted === undefined
    ? resolved.hosted === undefined && resolved.fetchSpec === requested.fetchSpec
    : resolved.hosted !== undefined && sshOf(requested.hosted, commit) === sshOf(resolved.hosted, commit)
  if (!same) return `asks for another repository than ${describe(child)} is from${commit ? ', or another commit' : ''}`
  if (requested.range === null || semver === undefined || semver.satisfies(version ?? '', requested.range, true)) return undefined
  return `asks for a version of the repository ${describe(child)} is not, ${version ?? 'of no version'}`
}

// depValid: why a node does not meet what a spec asks for, or undefined
// where it does.
function depValid(child, requested, semver) {
  switch (requested.type) {
    case 'registry':
      return registryValid(child, requested, semver)
    case 'alias':
      return registryValid(child, requested.sub, semver)
    case 'directory':
      if (child.kind === 'link' && directoryOf(child.target) === requested.path) return undefined
      return `asks for a link to ${quote(requested.path)}, and ${describe(child)} is ${child.kind === 'link' ? `one to ${quote(directoryOf(child.target))}` : 'no link'}`
    case 'file':
    case 'remote': {
      const tarball = requested.type === 'file' ? `file:${requested.path}` : requested.url
      if (child.kind !== 'link' && child.resolution?.tarball === tarball) return undefined
      return `asks for the tarball ${quote(tarball)}, and ${describe(child)} is from another`
    }
    default:
      return gitValid(child, requested, semver)
  }
}

// What npm passes over of a node that meets a spec, and this holds it to:
// the package an alias names, and the commit a repository on no host npm
// knows is asked at, which npm compares of one on a host alone.
function passedOver(child, requested) {
  const { name } = packageOf(child)
  if (requested.type === 'alias' && name !== requested.sub.name) return `asks for ${quote(requested.sub.name)}, and ${describe(child)} is ${quote(name)}, which npm does not check`
  const { committish } = requested
  if (requested.type === 'git' && COMMIT.test(committish ?? '') && committish.toLowerCase() !== child.resolution.commit) {
    return `asks for another commit than ${describe(child)} is of, which npm does not check of a repository on no host it knows`
  }
  return undefined
}

// Why npm does not take an edge as met by the node it leads to, as a
// refusal, or undefined where it does: Edge#valid, of the edge's spec or
// else acceptDependencies', and where `strict`, what npm passes over too.
// A spec not read here throws a LockfileError of no place.
function problem(edge, semver, strict) {
  const { from, to, spec } = edge
  if (edge.type.startsWith('peer') && to.parent === from && from.parent !== undefined) {
    return `${quote(spec)} is met in the node_modules of the package that asks for it, which npm holds a peer not to be`
  }
  if (to.folder !== edge.name) return `is met by ${describe(to)}, which npm takes for it, though the names are in other cases`
  const whyNot = (asked) => {
    const requested = readSpec(edge.name, asked, fromPath(from), semver)
    return depValid(to, requested, semver) ?? (strict ? passedOver(to, requested) : undefined)
  }
  const first = whyNot(spec)
  if (first === undefined || (edge.accept !== undefined && whyNot(edge.accept) === undefined)) return undefined
  return `${quote(spec)} ${first}, so npm would install another`
}

// Edge#valid, as npm has it, of an edge that leads to a node. A spec this
// does not read is taken as not met, as npm takes one it cannot read; npm
// reads a few this does not.
export function isValid(edge, semver) {
  return attempt(() => problem(edge, semver, false) === undefined, (error) => {
    if (error instanceof LockfileError) return false
    throw error
  })
}

function check(edge, semver) {
  if (edge.type === 'peerOptional') return
  const where = edgeAt(edge)
  if (edge.to === undefined) {
    throw new LockfileError(`${quote(edge.spec)} is met by nothing where npm looks for ${quote(edge.name)}, so npm would install it`, where)
  }
  const why = placed(() => problem(edge, semver, true), where)
  if (why !== undefined) throw new LockfileError(why, where)
}

// What npm's Edge#valid and buildIdealTree's problem edges are, from the
// project.
export function checkEdges(nodes, semver) {
  const reached = new Set([nodes.get('')])
  for (const node of reached) {
    const bundled = new Set(node.kind === 'package' ? node.bundleDependencies : [])
    for (const edge of node.edges.values()) {
      if (!bundled.has(edge.name)) check(edge, semver)
      const next = edge.to === undefined ? undefined : packageOf(edge.to)
      if (next !== undefined && !next.location.startsWith('../')) reached.add(next)
    }
  }
}

// What npm ci holds the tree to before it installs it (Arborist's
// buildIdealTree from the lockfile): from the project, each dependency of
// each node it reaches, through links into the directories in the project,
// has to be met where npm looks for it, by what it asks for. One that is
// not, npm resolves again, and installs something the lockfile does not
// say; or, as `npm ci`, refuses. An optional peer `npm ci` takes as the
// lockfile has it, met or not, and what a package bundles is what its
// tarball has, though npm looks into it. A directory out of the project
// npm leaves to itself.

import { LockfileError, quote } from '../error.js'
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
// npm takes, an alias among them; but an alias names its package itself,
// which npm does not check, and is held to it here.
function registryValid(child, { name, fetchSpec, kind }, semver, alias) {
  const pkg = packageOf(child)
  if (alias && pkg.name !== name) return `asks for ${quote(name)}, and ${describe(child)} is ${quote(pkg.name)}, which npm does not check`
  if (kind === undefined || (kind === 'range' && fetchSpec === '*')) return undefined
  if (kind === 'tag') {
    if (child.kind === 'link' || !/^https?:/u.test(child.resolution?.tarball ?? '')) return `is a tag, which npm holds met by a tarball from a URL alone, and ${describe(child)} is none`
    return undefined
  }
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
  // npm passes over the commit of a repository on no host it knows, which
  // is held to it here all the same.
  if (commit && requested.committish.toLowerCase() !== resolution.commit) {
    return `asks for another commit than ${describe(child)} is of, which npm does not check of a repository on no host it knows`
  }
  if (requested.range === null || semver === undefined || semver.satisfies(version ?? '', requested.range, true)) return undefined
  return `asks for a version of the repository ${describe(child)} is not, ${version ?? 'of no version'}`
}

// Why a node does not meet a spec, or undefined where it does: depValid,
// and the package an alias names held to it too.
function whyNot(child, edge, spec, semver) {
  const requested = readSpec(edge.name, spec, fromPath(edge.from), semver)
  switch (requested.type) {
    case 'registry':
      return registryValid(child, requested, semver, false)
    case 'alias':
      return registryValid(child, requested.sub, semver, true)
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

function check(edge, semver) {
  const { from, to, spec } = edge
  const where = edgeAt(edge)
  if (edge.type === 'peerOptional') return
  if (to === undefined) {
    throw new LockfileError(`${quote(spec)} is met by nothing where npm looks for ${quote(edge.name)}, so npm would install it`, where)
  }
  if (edge.type.startsWith('peer') && to.parent === from && from.parent !== undefined) {
    throw new LockfileError(`${quote(spec)} is met in the node_modules of the package that asks for it, which npm holds a peer not to be`, where)
  }
  if (to.folder !== edge.name) throw new LockfileError(`is met by ${describe(to)}, which npm takes for it, though the names are in other cases`, where)
  let why
  try {
    why = whyNot(to, edge, spec, semver)
    if (why !== undefined && edge.accept !== undefined && whyNot(to, edge, edge.accept, semver) === undefined) why = undefined
  } catch (error) {
    if (error instanceof LockfileError && error.where === undefined) throw new LockfileError(error.message, where)
    throw error
  }
  if (why !== undefined) throw new LockfileError(`${quote(spec)} ${why}, so npm would install another`, where)
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

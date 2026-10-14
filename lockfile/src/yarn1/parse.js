import { flagsOf } from '../graph.js'
import { checkOptions, checkSemver } from '../shape.js'
import { linkRequests, readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

const OPTIONS = ['manifests', 'checkVersions', 'semver']
const SEMVER = ['clean', 'satisfies', 'valid', 'validRange']

// yarn.lock says nothing of what is dev or optional: the manifests do, and
// without them the flags are undefined. A package only a resolution asks
// for, which yarn resolves and does not install, has every flag. Peers,
// which yarn.lock does not record and yarn installs none of, are not
// followed.
function setFlags(packages, importers) {
  const flags = importers === undefined ? () => ({ dev: undefined, optional: undefined, devOptional: undefined }) : flagsOf(packages, importers)
  for (const pkg of new Set(Object.values(packages))) Object.assign(pkg, flags(pkg))
}

export function parseYarn1Lockfile(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  // semver is taken where it is given, checkVersions or not.
  const { manifests, semver } = checkOptions(options, OPTIONS)
  checkSemver(options, SEMVER)
  const read = readPackages(readEntries(source), semver)
  const { packages, requests } = read
  if (manifests === undefined) linkRequests(requests, packages)
  const project = manifests === undefined ? undefined : readImporters(manifests, packages, requests, semver)
  checkResolutions(read, project, semver)
  setFlags(packages, project?.importers)
  return { packages, importers: project?.importers }
}

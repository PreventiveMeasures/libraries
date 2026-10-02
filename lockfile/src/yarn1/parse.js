import { checkOptions, checkSemver } from '../shape.js'
import { linkRequests, readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

const OPTIONS = ['manifests', 'checkVersions', 'semver']
const SEMVER = ['clean', 'satisfies', 'valid', 'validRange']

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
  return { packages, importers: project?.importers }
}

import { checkOptions } from '../shape.js'
import { linkWorkspace, readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

const OPTIONS = ['manifests', 'checkVersions', 'semver']
const SEMVER = ['clean', 'satisfies', 'valid', 'validRange']

function readOptions(options) {
  const { manifests, checkVersions = true, semver } = checkOptions(options, OPTIONS)
  if (typeof checkVersions !== 'boolean') throw new TypeError('checkVersions: expected a boolean')
  if (semver !== undefined && !SEMVER.every((name) => typeof semver?.[name] === 'function')) {
    throw new TypeError(`semver: expected the semver package, with ${SEMVER.join(', ')}`)
  }
  if (checkVersions && semver === undefined) throw new TypeError('checkVersions needs semver: pass it as semver, or set checkVersions to false')
  return { manifests, semver }
}

export function parseYarn1Lockfile(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { manifests, semver } = readOptions(options)
  const read = readPackages(readEntries(source), semver)
  const { packages, requests } = read
  if (manifests === undefined) for (const request of requests) if (!(request.pattern in packages)) linkWorkspace(request)
  const project = manifests === undefined ? undefined : readImporters(manifests, packages, requests, semver)
  checkResolutions(read, project, semver)
  return { packages, importers: project?.importers }
}

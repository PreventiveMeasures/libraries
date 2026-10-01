import { quote } from '../error.js'
import { linkWorkspaces, readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { checkRanges, checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

const OPTIONS = ['manifests', 'checkVersions', 'semver']
const SEMVER = ['clean', 'satisfies', 'valid', 'validRange']

function readOptions(options) {
  if (typeof options !== 'object' || options === null) throw new TypeError('expected an options object')
  const unknown = Object.keys(options).find((key) => !OPTIONS.includes(key))
  if (unknown !== undefined) throw new TypeError(`unknown option ${quote(unknown)}, of ${OPTIONS.join(', ')}`)
  const { manifests, checkVersions = true, semver } = options
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
  const { packages, patterns, mixed, unresolved } = readPackages(readEntries(source), semver)
  if (manifests === undefined) linkWorkspaces(unresolved, undefined, semver)
  const project = manifests === undefined ? undefined : readImporters(manifests, packages, unresolved, semver)
  const plain = checkResolutions(mixed, packages, project)
  if (semver !== undefined) checkRanges(patterns, plain, semver, project !== undefined)
  return { packages, importers: project?.importers }
}

import { readImporters } from './importers.js'
import { linkUnresolved, readPackages } from './packages.js'
import { checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

export function parseYarn1Lockfile(source, manifests) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { packages, mixed, unresolved } = readPackages(readEntries(source))
  if (manifests === undefined) linkUnresolved(unresolved, undefined)
  const project = manifests === undefined ? undefined : readImporters(manifests, packages, unresolved)
  checkResolutions(mixed, packages, project)
  return { packages, importers: project?.importers }
}

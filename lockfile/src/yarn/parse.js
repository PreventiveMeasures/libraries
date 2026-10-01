import { readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { checkResolutions } from './resolutions.js'
import { readEntries } from './syntax.js'

export function parseYarnLockfile(source, manifests) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { packages, mixed } = readPackages(readEntries(source))
  const project = manifests === undefined ? undefined : readImporters(manifests, packages)
  checkResolutions(mixed, packages, project)
  return { packages, importers: project?.importers }
}

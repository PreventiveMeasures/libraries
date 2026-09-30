// A yarn.lock of `# yarn lockfile v1`, as yarn 1 writes it: syntax.js reads
// the text, packages.js the entries, importers.js, where the manifests are
// handed over, the projects that ask for them, and resolutions.js whether
// the resolutions they make explain the entries packages.js hands back.

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

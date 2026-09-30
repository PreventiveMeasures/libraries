// A yarn.lock of `# yarn lockfile v1`, as yarn 1 writes it: syntax.js reads
// the text, packages.js the entries, and importers.js, where the manifests
// are handed over, the projects that ask for them, and resolutions.js the
// resolutions they make.

import { readImporters } from './importers.js'
import { readPackages, unresolved } from './packages.js'
import { readEntries } from './syntax.js'

export function parseYarnLockfile(source, manifests) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { packages, mixed } = readPackages(readEntries(source))
  if (manifests !== undefined) return { packages, importers: readImporters(manifests, packages, mixed) }
  if (mixed.length > 0) throw unresolved(mixed[0])
  return { packages, importers: undefined }
}

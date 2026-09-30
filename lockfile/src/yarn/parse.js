// A yarn.lock of `# yarn lockfile v1`, as yarn 1 writes it: syntax.js reads
// the text, packages.js the entries, and importers.js, where the manifests
// are handed over, the projects that ask for them.

import { readImporters } from './importers.js'
import { readPackages } from './packages.js'
import { readEntries } from './syntax.js'

export function parseYarnLockfile(source, manifests) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const packages = readPackages(readEntries(source))
  return { packages, importers: manifests === undefined ? undefined : readImporters(manifests, packages) }
}

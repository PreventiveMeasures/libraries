// The importers: the projects a lockfile installs, each under its directory
// relative to the lockfile's (`.` for the one beside it), each with what its
// manifest asks for and what that resolved to. They come back in the shape
// pnpm reads them into: `specifiers` for every dependency, then a mapping
// of targets for each kind, one kind to an alias, as pnpm's writer lists
// one. The env document has one importer, `.`, with two kinds of its own.

import { LockfileError, at } from '../error.js'
import { checkName, checkRelative } from '../names.js'
import { KINDS } from '../graph.js'
import { boolean, entries, field, mapping, orEmpty, record, string, text } from '../shape.js'
import { target } from './packages.js'

const FIELDS = [...KINDS, 'dependenciesMeta', 'publishDirectory', 'linkDirectory']
export const ENV_KINDS = ['configDependencies', 'packageManagerDependencies']

// An importer's links are written from its own directory.
function readDependencies(importer, kinds, id, where, snapshots) {
  const specifiers = Object.create(null)
  const result = { specifiers }
  const kindOf = Object.create(null)
  for (const kind of kinds) {
    const targets = Object.create(null)
    for (const [alias, dependency, here] of entries(orEmpty(importer[kind]), at(where, kind))) {
      checkName(alias, here)
      record(dependency, here, ['specifier', 'version'])
      if (alias in specifiers) throw new LockfileError(`listed under ${kindOf[alias]} too`, here)
      specifiers[alias] = string(dependency.specifier, at(here, 'specifier'))
      kindOf[alias] = kind
      const version = at(here, 'version')
      targets[alias] = target(text(dependency.version, version), alias, id, snapshots, version)
    }
    result[kind] = targets
  }
  return result
}

// What a dependency's meta may carry into the lockfile: `injected`, a
// workspace package installed as a copy, a `file:` snapshot, rather than
// linked; and `node`, the Node executable its bins are run with, where it
// is not the one pnpm runs on.
const readMeta = (value, where) => mapping(orEmpty(value), where, (item, here, name) => {
  record(item, here, ['injected', 'node'])
  checkName(name, here)
  return { injected: field(item, 'injected', here, boolean) ?? false, node: field(item, 'node', here, text) }
})

// `publishDirectory` is the subdirectory a project is linked by instead of
// its own, unless `linkDirectory` is false.
function readImporter(importer, id, where, snapshots) {
  record(importer, where, FIELDS)
  if (importer.linkDirectory !== undefined && importer.linkDirectory !== false) {
    throw new LockfileError('expected false, the only value pnpm writes', at(where, 'linkDirectory'))
  }
  return {
    ...readDependencies(importer, KINDS, id, where, snapshots),
    dependenciesMeta: readMeta(importer.dependenciesMeta, at(where, 'dependenciesMeta')),
    publishDirectory: field(importer, 'publishDirectory', where, checkRelative),
    linkDirectory: importer.linkDirectory !== false,
  }
}

export function readImporters(value, where, snapshots, env) {
  const importers = Object.create(null)
  for (const [id, importer, here] of entries(value, where)) {
    checkRelative(id, here)
    if (!env) {
      importers[id] = readImporter(importer, id, here, snapshots)
      continue
    }
    if (id !== '.') throw new LockfileError('the env document has no importer but "."', here)
    record(importer, here, ENV_KINDS)
    importers[id] = readDependencies(importer, ENV_KINDS, id, here, snapshots)
  }
  if (env && !('.' in importers)) throw new LockfileError('expected the "." importer', where)
  return importers
}

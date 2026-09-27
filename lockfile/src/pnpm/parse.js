// A pnpm lockfile, `lockfileVersion: '9.0'`, as pnpm 9 to 12 write it. The
// fields read are the ones below; any other, at any depth, is refused
// rather than dropped, and so is any older format.
//
// pnpm 11 and later write a file of two documents where there is something
// to lock beside the project: the env document first, with the config
// dependencies and, from pnpm 12, the package manager a project pins, locked
// the same way; the project's lockfile second. Before anything is installed
// the second may be missing, and the file ends at the `---` after the env
// document.

import { parseYamlStream } from '@preventive/yaml'
import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative } from '../names.js'
import { EMPTY, boolean, count, entries, kind, record, string, text, textMap } from '../shape.js'
import { ENV_KINDS, KINDS, readImporters } from './importers.js'
import { readPackages } from './packages.js'

const FIELDS = ['lockfileVersion', 'settings', 'catalogs', 'overrides', 'patchedDependencies', 'importers', 'packages', 'snapshots']
const ENV_FIELDS = ['lockfileVersion', 'importers', 'packages', 'snapshots']

const SETTINGS = {
  __proto__: null,
  autoInstallPeers: boolean,
  dedupePeers: boolean,
  excludeLinksFromLockfile: boolean,
  injectWorkspacePackages: boolean,
  peersSuffixMaxLength: count,
}

function readSettings(value, where) {
  const settings = Object.create(null)
  for (const [key, item, here] of entries(record(value ?? EMPTY, where, Object.keys(SETTINGS)), where)) settings[key] = SETTINGS[key](item, here)
  return settings
}

// Each catalog, `default` among them, maps a name to the specifier the
// catalog gives it and the version that resolved to.
function readCatalogs(value, where) {
  const catalogs = Object.create(null)
  for (const [catalog, names, here] of entries(value ?? EMPTY, where)) {
    const entriesOf = Object.create(null)
    for (const [name, item, there] of entries(names, here)) {
      record(item, there, ['specifier', 'version'])
      entriesOf[checkName(name, there)] = { specifier: string(item.specifier, at(there, 'specifier')), version: text(item.version, at(there, 'version')) }
    }
    catalogs[text(catalog, here)] = entriesOf
  }
  return catalogs
}

// pnpm 9 and 10 write a patch as its hash and the path of its file; pnpm 11
// and later as the hash alone.
function readPatches(value, where) {
  const patches = Object.create(null)
  for (const [selector, item, here] of entries(value ?? EMPTY, where)) {
    const full = typeof item !== 'string'
    if (full) record(item, here, ['hash', 'path'])
    const hash = text(full ? item.hash : item, full ? at(here, 'hash') : here)
    if (!/^[\da-z]+$/u.test(hash)) throw new LockfileError(`${quote(hash)} is not a patch hash`, full ? at(here, 'hash') : here)
    patches[text(selector, here)] = { hash, path: full ? checkRelative(item.path, at(here, 'path')) : undefined }
  }
  return patches
}

// Every snapshot is reached from an importer, as pnpm prunes the rest: one
// that is not would be listed as installed when nothing installs it.
function checkReached(importers, packages, where) {
  const reached = new Set()
  const queue = []
  const visit = (targets = EMPTY) => {
    for (const key of Object.values(targets)) {
      if (key.startsWith('link:') || reached.has(key)) continue
      reached.add(key)
      queue.push(key)
    }
  }
  for (const importer of Object.values(importers)) for (const field of [...KINDS, ...ENV_KINDS]) visit(importer[field])
  while (queue.length > 0) {
    const pkg = packages[queue.pop()]
    visit(pkg.dependencies)
    visit(pkg.optionalDependencies)
  }
  for (const key of Object.keys(packages)) {
    if (!reached.has(key)) throw new LockfileError('no importer depends on it, directly or not', at(at(where, 'snapshots'), key))
  }
}

function readDocument(doc, prefix, env) {
  const where = prefix === '' ? undefined : prefix
  const version = record(doc, where).lockfileVersion
  if (version !== '9.0') throw new LockfileError(`unsupported version: expected "9.0", found ${kind(version)}`, at(prefix, 'lockfileVersion'))
  record(doc, where, env ? ENV_FIELDS : FIELDS)
  const patchedDependencies = readPatches(doc.patchedDependencies, at(prefix, 'patchedDependencies'))
  const hashes = new Set(Object.values(patchedDependencies).map((patch) => patch.hash))
  const { packages, snapshots } = readPackages(doc, prefix, hashes)
  const importers = readImporters(doc.importers, at(prefix, 'importers'), snapshots, env)
  checkReached(importers, packages, prefix)
  if (env) return { lockfileVersion: version, importers, packages }
  return {
    lockfileVersion: version,
    settings: readSettings(doc.settings, at(prefix, 'settings')),
    catalogs: readCatalogs(doc.catalogs, at(prefix, 'catalogs')),
    overrides: textMap(doc.overrides ?? EMPTY, at(prefix, 'overrides'), text),
    patchedDependencies,
    importers,
    packages,
  }
}

// The split is pnpm's own (@pnpm/lockfile.fs, yamlDocuments.js), made on
// the text: a file that starts with a line of `---` leads with the env
// document, which runs to the next line of `---` alone, and what follows
// that is the project's lockfile, unless it is blank, when there is none.
// The YAML is still read as one stream, so a line number counts from the
// top of the file, and has to hold the documents the split does.
export function parsePnpmLockfile(source) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const lead = /^---\r?\n/u.exec(source)?.[0]
  if (lead === undefined) {
    const docs = parseYamlStream(source)
    if (docs.length !== 1) throw new LockfileError(`expected one document, found ${docs.length}`)
    return { lockfile: readDocument(docs[0], '', false), env: undefined }
  }
  const separator = /\n---\r?\n/gu
  separator.lastIndex = lead.length
  const found = separator.exec(source)
  if (found === null) throw new LockfileError('expected the env document the first "---" starts to end at a line of "---"')
  const alone = source.slice(separator.lastIndex).trim() === ''
  const docs = parseYamlStream(alone ? source.slice(0, found.index + 1) : source)
  if (docs.length !== (alone ? 1 : 2)) {
    throw new LockfileError(`expected the env document${alone ? '' : ' and the lockfile'} between lines of "---" alone, found ${docs.length} documents`)
  }
  return { lockfile: alone ? undefined : readDocument(docs[1], '', false), env: readDocument(docs[0], 'env', true) }
}

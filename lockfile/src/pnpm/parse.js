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

import { parseYamlStream } from '../yaml/parse.js'
import { fromBase32 } from '@exodus/bytes/base32.js'
import { fromHex } from '@exodus/bytes/hex.js'
import { LockfileError, at, attempt, quote } from '../error.js'
import { KINDS, unreached } from '../graph.js'
import { checkIntegrity, checkRelative } from '../names.js'
import { boolean, count, field, kind, mapping, orEmpty, record, string, text, textMap, texts } from '../shape.js'
import { ENV_KINDS, readImporters } from './importers.js'
import { byName, readPackages } from './packages.js'

const FIELDS = [
  'lockfileVersion', 'settings', 'catalogs', 'overrides', 'patchedDependencies',
  'packageExtensionsChecksum', 'pnpmfileChecksum', 'ignoredOptionalDependencies', 'time',
  'importers', 'packages', 'snapshots',
]
const ENV_FIELDS = ['lockfileVersion', 'importers', 'packages', 'snapshots']

const SETTINGS = {
  __proto__: null,
  autoInstallPeers: boolean,
  dedupePeers: boolean,
  excludeLinksFromLockfile: boolean,
  injectWorkspacePackages: boolean,
  peersSuffixMaxLength: count,
}

const readSettings = (value, where) => mapping(record(orEmpty(value), where, Object.keys(SETTINGS)), where, (item, here, key) => SETTINGS[key](item, here))

// Each catalog, `default` among them, maps a name to the specifier the
// catalog gives it and the version that resolved to.
const readCatalogs = (value, where) => mapping(orEmpty(value), where, (names, here, catalog) => {
  text(catalog, here)
  return byName(['specifier', 'version'], (item, there) => ({ specifier: string(item.specifier, at(there, 'specifier')), version: text(item.version, at(there, 'version')) }))(names, here)
})

// A bare hash as pnpm writes one: lowercase hex, or base32 unpadded, of so
// many bytes. Either decoder takes either case, and refuses all else.
const fromBase32Bare = (hash) => fromBase32(hash, { padding: false })

const isHash = (hash, bytes, decode) => attempt(() => hash === hash.toLowerCase() && decode(hash).length === bytes, () => false)

// pnpm 9 and 10 write a patch as its hash and the path of its file; pnpm 11
// and later as the hash alone: an md5 in base32 from pnpm 9, a sha256 in hex.
const readPatches = (value, where) => mapping(orEmpty(value), where, (item, here, selector) => {
  const full = typeof item !== 'string'
  if (full) record(item, here, ['hash', 'path'])
  const hashAt = full ? at(here, 'hash') : here
  const hash = text(full ? item.hash : item, hashAt)
  if (!isHash(hash, 32, fromHex) && !isHash(hash, 16, fromBase32Bare)) throw new LockfileError(`${quote(hash)} is not a patch hash`, hashAt)
  text(selector, here)
  return { hash, path: full ? checkRelative(item.path, at(here, 'path')) : undefined }
})

// A digest of what rewrote the manifests pnpm resolved from: pnpm 9 writes
// an md5 bare, in hex or base32, and pnpm 10 and later a sha256 integrity.
function readChecksum(value, where) {
  const checksum = text(value, where)
  if (isHash(checksum, 16, fromHex) || isHash(checksum, 16, fromBase32Bare)) return checksum
  if (!checksum.startsWith('sha256-')) throw new LockfileError(`${quote(checksum)} is not a checksum`, where)
  return checkIntegrity(checksum, where)
}

// When a direct dependency was published, by its package key, where pnpm
// resolved by time (`resolution-mode=time-based`): a UTC timestamp, as the
// registry gives it. A date that would roll over, February 30th or 24:00,
// is refused rather than read as another.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u

const readTime = (value, where, packages) => mapping(orEmpty(value), where, (item, here, key) => {
  if (!(key in packages)) throw new LockfileError(`${quote(key)} is not in packages`, here)
  const stamp = text(item, here)
  const ms = TIMESTAMP.test(stamp) ? Date.parse(stamp) : Number.NaN
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== stamp.slice(0, 19)) {
    throw new LockfileError(`${quote(stamp)} is not a UTC timestamp`, here)
  }
  return stamp
})

// Every snapshot is reached from an importer, as pnpm prunes the rest: one
// that is not would be listed as installed when nothing installs it.
function checkReached(importers, packages, where, kinds) {
  const stray = unreached(Object.values(importers).flatMap((importer) => kinds.map((list) => importer[list])), packages)
  if (stray !== undefined) throw new LockfileError('no importer depends on it, directly or not', at(at(where, 'snapshots'), stray))
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
  checkReached(importers, packages, prefix, env ? ENV_KINDS : KINDS)
  if (env) return { lockfileVersion: version, importers, packages }
  return {
    lockfileVersion: version,
    settings: readSettings(doc.settings, at(prefix, 'settings')),
    catalogs: readCatalogs(doc.catalogs, at(prefix, 'catalogs')),
    overrides: textMap(orEmpty(doc.overrides), at(prefix, 'overrides'), text),
    patchedDependencies,
    packageExtensionsChecksum: field(doc, 'packageExtensionsChecksum', prefix, readChecksum),
    pnpmfileChecksum: field(doc, 'pnpmfileChecksum', prefix, readChecksum),
    ignoredOptionalDependencies: field(doc, 'ignoredOptionalDependencies', prefix, texts) ?? [],
    time: readTime(doc.time, at(prefix, 'time'), orEmpty(doc.packages)),
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

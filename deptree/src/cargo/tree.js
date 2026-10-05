// The vendor directory `cargo vendor` makes from a Cargo.lock.

import { LockfileError, linkCargo, parseCargoConfig, parseCargoLock, parseCargoManifest, readCargoVendor } from '@preventive/lockfile/cargo.js'
import { TomlError, parseToml } from '@preventive/lockfile/toml.js'
import { Vfs } from '@preventive/vfs'
import { DeptreeError, quote } from '../error.js'
import { fold, makeDirs, mount, writeFiles } from '../mount.js'
import { decodeUtf8 } from '../project.js'
import { checkHost, inputsOf } from './inputs.js'
import { about, fetchCrates, vendoredPackages } from './registry.js'
import { fileOf, findWorkspace } from './workspace.js'

function checkNoVendor(vfs, folded) {
  for (const name of vfs.readdir('/')) {
    if (name === 'vendor' || (folded && fold(name) === 'vendor')) {
      throw new DeptreeError('a vendor directory is there already, which is neither kept beside the tree nor removed', `vfs[${quote(`/${name}`)}]`)
    }
  }
}

function refusal(error, where) {
  if (error instanceof LockfileError || error instanceof TomlError) return new DeptreeError(error.message, where, { cause: error })
  return error
}

// Of the config, [patch] is read, as cargo resolves with it; `paths`, which
// overrides where packages come from, and `include`, which reads more
// files, are refused; the rest bears on no package vendored.
function configOf({ text, file }) {
  if (text === undefined) return { patch: parseCargoConfig([]).patch, file }
  try {
    const doc = parseToml(text)
    for (const key of ['paths', 'include']) if (doc[key] !== undefined) throw new DeptreeError('not supported', `${file}: ${key}`)
    return { patch: parseCargoConfig([text]).patch, file }
  } catch (error) {
    throw refusal(error, file)
  }
}

// Each path package by the key the lockfile gives it, `name version`: every
// one of the lockfile's has to be one cargo reads, and every member there.
function pathKeys(lock, packages) {
  const keys = new Map()
  const dirs = new Map()
  for (const [dir, { manifest, member }] of packages) {
    if (manifest.package === undefined) continue
    const key = `${manifest.package.name} ${manifest.package.version}`
    if (dirs.has(key)) throw new DeptreeError(`it and ${quote(fileOf(dirs.get(key)))} are both ${quote(key)}, which the lockfile names one package`, fileOf(dir))
    if (member && lock.packages[key] === undefined) throw new DeptreeError(`the lockfile has no member ${quote(key)}: is it out of date?`, fileOf(dir))
    keys.set(dir, key)
    dirs.set(key, dir)
  }
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.source === undefined && !dirs.has(key)) throw new DeptreeError('a path package that no manifest cargo reads here is: is the lockfile out of date?', about(key))
  }
  return keys
}

// linkCargo ties a path dependency to a path package by name and version;
// it has to be the one in the directory the path leads to.
function checkPaths(graph, packages, keys) {
  for (const [dir, { links }] of packages) {
    const linked = graph.packages[keys.get(dir)]
    if (linked === undefined) continue
    for (const { index, dir: to, where } of links) {
      const { resolved } = linked.dependencies[index]
      if (resolved !== undefined && resolved !== keys.get(to)) throw new DeptreeError(`the lockfile resolves it to ${quote(resolved)}, not ${quote(keys.get(to))}, which its path leads to`, where)
    }
  }
}

function manifestOf(crate, vendored) {
  const where = `${about(crate.key)}: Cargo.toml`
  const file = vendored.files.get('Cargo.toml')
  if (file === undefined) throw new DeptreeError('its .crate has no Cargo.toml', about(crate.key))
  const text = decodeUtf8(file.data, 'not UTF-8, which cargo fails on', where)
  try {
    return { text, manifest: parseCargoManifest(text) }
  } catch (error) {
    throw refusal(error, where)
  }
}

// The lockfile laid over every manifest, as linkCargo holds it to them; then
// the vendored copies read back as cargo's directory source reads them.
function checkLock(lock, inputs, crates, vendored) {
  const keys = pathKeys(lock, inputs.packages)
  const manifests = Object.create(null)
  for (const [dir, key] of keys) if (key in lock.packages) manifests[key] = inputs.packages.get(dir).manifest
  const texts = new Map(crates.map((crate) => [crate.key, manifestOf(crate, vendored.get(crate.key))]))
  for (const [key, { manifest }] of texts) manifests[key] = manifest
  const members = [...inputs.packages].filter(([dir, { member }]) => member && keys.has(dir)).map(([dir]) => keys.get(dir))
  checkPaths(linkCargo(lock, manifests, { workspace: inputs.root, members, config: { patch: inputs.config.patch } }), inputs.packages, keys)
  const read = readCargoVendor(lock, Object.fromEntries(crates.map((crate) => [crate.directory, { manifest: texts.get(crate.key).text, checksum: vendored.get(crate.key).checksumText }])))
  for (const crate of crates) if (read[crate.key].directory !== crate.directory) throw new Error(`unreachable: ${crate.key} read back from ${read[crate.key].directory}`)
}

function writeTree(crates, vendored, stats) {
  const vfs = new Vfs()
  if (crates.length > 0) makeDirs(vfs, 'vendor')
  for (const { key, directory } of crates) {
    const { root, dirs, files } = vendored.get(key)
    const path = `vendor/${directory}`
    writeFiles(vfs, path, { dirs: new Set(dirs.keys()), files }, stats)
    for (const [dir, mode] of dirs) vfs.chmod(`/${path}/${dir}`, mode)
    vfs.chmod(`/${path}`, root)
  }
  return vfs
}

export async function buildCargoTree(options) {
  const { host: given, vfs: into } = options ?? {}
  if (into !== undefined && !(into instanceof Vfs)) throw new TypeError('vfs must be a Vfs, or left out')
  const inputs = inputsOf(options ?? {})
  const host = checkHost(given)
  const folded = host.os === 'darwin'
  // Refused before anything is fetched; mount checks again.
  if (into !== undefined) checkNoVendor(into, folded)
  const lock = parseCargoLock(inputs.lockfile)
  const config = configOf(inputs.config)
  const { root, packages, read } = findWorkspace(inputs.project, config, folded)
  for (const dir of inputs.given ?? []) {
    if (read.get(dir) === undefined) throw new DeptreeError('given, but no manifest cargo reads', `manifests[${quote(dir)}]`)
  }
  const crates = vendoredPackages(lock)
  pathKeys(lock, packages)
  const vendored = await fetchCrates(crates, host.comment)
  checkLock(lock, { root, packages, config }, crates, vendored)
  const stats = { packages: Object.keys(lock.packages).length, vendored: crates.length, files: 0, bytes: 0 }
  const vfs = writeTree(crates, vendored, stats)
  const installed = crates.map(({ key, directory, name, version, checksum }) => ({ path: `vendor/${directory}`, name, version, source: lock.packages[key].source, checksum }))
  return { vfs: mount(vfs, into, folded, checkNoVendor), stats, installed }
}

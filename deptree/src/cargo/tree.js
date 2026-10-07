// The vendor directory `cargo vendor` makes from a Cargo.lock.

import { linkCargo, parseCargoConfig, parseCargoLock, parseCargoManifest, readCargoVendor } from '@preventive/lockfile/cargo.js'
import { parseToml } from '@preventive/lockfile/toml.js'
import { Vfs } from '@preventive/vfs'
import { DeptreeError, quote } from '../error.js'
import { own } from '../manifest.js'
import { checkNoDir, mount, writeFiles } from '../mount.js'
import { decodeUtf8 } from '../project.js'
import { checkHost, inputsOf } from './inputs.js'
import { about, fetchCrates, vendoredPackages } from './registry.js'
import { fileOf, findWorkspace, parseAs } from './workspace.js'

const checkNoVendor = checkNoDir('vendor', 'a vendor directory')

// Of the config, [patch] is read, as cargo resolves with it; `paths`, which
// overrides where packages come from, and `include`, which reads more
// files, are refused; the rest bears on no package vendored.
function configOf({ text, file }) {
  if (text === undefined) return { patch: parseCargoConfig([]).patch, file }
  const doc = parseAs(file, () => parseToml(text))
  for (const key of ['paths', 'include']) if (doc[key] !== undefined) throw new DeptreeError('not supported', `${file}: ${key}`)
  return { patch: parseAs(file, () => parseCargoConfig([text])).patch, file }
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

// `links` are the repository and homepage the Cargo.toml cargo packed gives
// in [package], or [project] as cargo reads it too: strings, as
// parseCargoManifest holds them to, or undefined.
function manifestOf(crate, vendored) {
  const where = `${about(crate.key)}: Cargo.toml`
  const file = vendored.files.get('Cargo.toml')
  if (file === undefined) throw new DeptreeError('its .crate has no Cargo.toml', about(crate.key))
  const text = decodeUtf8(file.data, 'not UTF-8, which cargo fails on', where)
  const manifest = parseAs(where, () => parseCargoManifest(text))
  const doc = parseToml(text)
  const pkg = own(doc, 'package') ?? own(doc, 'project')
  return { text, manifest, links: { repository: own(pkg, 'repository'), homepage: own(pkg, 'homepage') } }
}

// The lockfile laid over every manifest, as linkCargo holds it to them; then
// the vendored copies read back as cargo's directory source reads them.
// Gives back each crate's links, by its key.
function checkLock(lock, inputs, crates, vendored) {
  const { keys } = inputs
  const manifests = Object.create(null)
  for (const [dir, key] of keys) if (key in lock.packages) manifests[key] = inputs.packages.get(dir).manifest
  const texts = new Map(crates.map((crate) => [crate.key, manifestOf(crate, vendored.get(crate.key))]))
  for (const [key, { manifest }] of texts) manifests[key] = manifest
  const members = [...inputs.packages].filter(([dir, { member }]) => member && keys.has(dir)).map(([dir]) => keys.get(dir))
  checkPaths(linkCargo(lock, manifests, { workspace: inputs.root, members, config: inputs.config }), inputs.packages, keys)
  const read = readCargoVendor(lock, Object.fromEntries(crates.map((crate) => [crate.directory, { manifest: texts.get(crate.key).text, checksum: vendored.get(crate.key).checksumText }])))
  for (const crate of crates) if (read[crate.key].directory !== crate.directory) throw new Error(`unreachable: ${crate.key} read back from ${read[crate.key].directory}`)
  return new Map([...texts].map(([key, { links }]) => [key, links]))
}

// Each crate's bytes are let go once its files are written, which copies them.
function writeTree(crates, vendored, stats) {
  const vfs = new Vfs()
  for (const { key, directory } of crates) {
    const { root, dirs, files } = vendored.get(key)
    const path = `vendor/${directory}`
    writeFiles(vfs, path, { dirs: dirs.keys(), files }, stats)
    for (const [dir, mode] of dirs) vfs.chmod(`/${path}/${dir}`, mode)
    vfs.chmod(`/${path}`, root)
    vendored.delete(key)
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
  const keys = pathKeys(lock, packages)
  const vendored = await fetchCrates(crates, host.comment)
  const links = checkLock(lock, { root, packages, config, keys }, crates, vendored)
  const stats = { packages: Object.keys(lock.packages).length, vendored: crates.length, files: 0, bytes: 0 }
  // Before writeTree lets each crate go.
  const installed = crates.map(({ key, directory, name, version, checksum }) => ({ path: `vendor/${directory}`, name, version, source: lock.packages[key].source, checksum, commit: vendored.get(key).commit, ...links.get(key) }))
  const vfs = writeTree(crates, vendored, stats)
  return { vfs: mount(vfs, into, folded, checkNoVendor), stats, installed }
}

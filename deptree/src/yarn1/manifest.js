// A package.json as yarn 1 reads one (util/normalize-manifest): its text
// parsed, its dependency lists as yarn leaves them, its workspace globs,
// and what of the root's yarn fails on, or would install otherwise than
// this follows.

import { DeptreeError, quote } from '../error.js'

// yarn's readJson reads a package.json as pnpm does: a byte order mark
// dropped.
export { readManifest } from '../pnpm/projects.js'

// yarn's cleanDependencies: a name in several of the dependency lists kept
// in the first of optionalDependencies, dependencies and devDependencies,
// at the first of its ranges that is neither '' nor '*'.
export function cleanDependencies(manifest) {
  const kinds = ['optionalDependencies', 'dependencies', 'devDependencies'].filter((kind) => manifest[kind] !== null && typeof manifest[kind] === 'object')
  const ranges = new Map()
  for (const kind of kinds) {
    for (const [name, range] of Object.entries(manifest[kind])) if (!ranges.has(name) && range && range !== '*') ranges.set(name, range)
  }
  const seen = new Set()
  for (const kind of kinds) {
    const list = manifest[kind]
    for (const name of Object.keys(list)) {
      if (seen.has(name)) delete list[name]
      else {
        list[name] = ranges.get(name) ?? list[name]
        seen.add(name)
      }
    }
  }
  return manifest
}

// The lists of a package.json this reads, as yarn's normalize-manifest
// leaves them: a `//` key, a comment, dropped, a value that is not one
// given as `''`, and a name in several of the dependency lists kept in
// one (cleanDependencies). A copy; the manifest is left as it is.
const LISTS = ['resolutions', 'devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']
export function fixLists(manifest) {
  const fixed = { ...manifest }
  for (const kind of LISTS) {
    const list = manifest[kind]
    if (!list || typeof list !== 'object') continue
    const copy = Array.isArray(list) ? [...list] : { ...list }
    delete copy['//']
    for (const name in copy) copy[name] = copy[name] || ''
    fixed[kind] = copy
  }
  return cleanDependencies(fixed)
}

// The workspace globs of the root, as yarn reads them.
export function globsOf(root) {
  const value = root.workspaces
  if (value === undefined) return []
  return (Array.isArray(value) ? value : value?.packages ?? []).map((glob) => String(glob).replace(/^(?:\.\/)+|\/+$/gu, ''))
}

// What yarn's normalize-manifest fails on in the root's name and version,
// which the lockfile reader does not read; and what of the root yarn would
// install otherwise than this follows.
const NAME = /[/@\s+%:]/u
const validName = (name) => !NAME.test(name) && encodeURIComponent(name) === name
export function checkRoot(root) {
  const { name, version } = root
  for (const [key, value] of Object.entries({ name, version })) {
    if (value && typeof value !== 'string') throw new DeptreeError('not a string, which yarn fails on', `manifests["."].${key}`)
  }
  if (typeof name === 'string') {
    const parts = name.startsWith('@') ? name.slice(1).split('/') : undefined
    const legal = parts === undefined ? validName(name) : parts.length === 2 && parts.every(validName)
    if (name.startsWith('.') || !legal || ['node_modules', 'favicon.ico'].includes(name.toLowerCase())) throw new DeptreeError(`${quote(name)} is a name yarn fails on`, 'manifests["."].name')
  }
  if (root.installConfig?.pnp) throw new DeptreeError('Plug\'n\'Play is not supported', 'manifests["."].installConfig.pnp')
  if (root.flat) throw new DeptreeError('a flat install is not supported', 'manifests["."].flat')
  const nohoist = root.workspaces?.nohoist
  if (Array.isArray(nohoist) && nohoist.length > 0) throw new DeptreeError('nohoist is not supported', 'manifests["."].workspaces.nohoist')
}

// What pnpm 12's hoisted linker does besides hoist and copy (hoisted.js): its walk leaves out a package the
// host cannot run that only optional dependencies reach; each project links what it depends on where it is in
// no node_modules it resolves from (direct_links.rs), and its `link:`s; named projects as for pnpm 11

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { basename, compareNames, dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { within } from '../mount.js'
import { hoistedLayout, modulesOf, pkgId12, projectLinks, workspaceHoists } from './hoisted.js'
import { validForOldPackages } from './overrides.js'

// pnpm 12 holds each alias it places to validate-npm-package-name's rule for
// old packages, but for a leading `-` and a scope's name with a leading `.`.
function checkAlias(alias, modules) {
  if (!validForOldPackages(alias) || alias.startsWith('-') || alias.includes('/.')) throw new DeptreeError(`${quote(alias)} is an alias pnpm 12 refuses to place a dependency by`, quote(modules))
}

// pnpm 12 reads each key, the name to the first `@` past its first character, `runtime:` or nothing, then the
// version to the first `(` of a key that ends in `)`, and fails on one it cannot
function readable(key) {
  const sep = key.indexOf('@', 1)
  const [name, suffix] = [key.slice(0, sep), key.slice(sep + 1)]
  if (sep === -1 || name === '@' || name === '@/' || (name.startsWith('@') && !name.includes('/')) || suffix === '') return false
  const body = suffix.replace(/^runtime:/u, '')
  const open = body.endsWith(')') ? body.indexOf('(') : body.length
  return !(body !== suffix && body.startsWith('file:')) && open !== -1 && !/[()]/u.test(body.slice(0, open)) && !['', 'file:'].includes(body.slice(0, open))
}

function checkKeys(lockfile) {
  for (const key of Object.keys(lockfile.packages)) {
    for (const [read, where] of [[packageKeyOf(key), 'packages'], [key, 'snapshots']]) {
      if (!readable(read)) throw new DeptreeError('pnpm 12 fails to read this key, which it splits into a version and peers at the first "("', `${where}[${quote(read)}]`)
    }
  }
}

const dependenciesOf = ({ dependencies, devDependencies, optionalDependencies }) => Object.entries({ ...dependencies, ...devDependencies, ...optionalDependencies })

// pnpm 12's layout, with `direct`: by project and alias, where each direct dependency resolves, the root every
// package in its node_modules, another its own copy of the snapshot, else the snapshot's first, else its own of
// the package, else the package's first (walk.rs's direct_dep_location)
export function hoistedLayout12(lockfile, { skipped, leftOut }) {
  checkKeys(lockfile)
  const { placed, skipped: left } = hoistedLayout(lockfile, { autoInstallPeers: true, skipped, leftOut, checkAlias, pnpm12: true })
  const first = new Map()
  const firstOfId = new Map()
  for (const { key, dir } of placed.values()) {
    if (!first.has(key)) first.set(key, dir)
    if (!firstOfId.has(pkgId12(key))) firstOfId.set(pkgId12(key), dir)
  }
  const directOf = (own, key) => {
    const ownKey = placed.get(own)?.key
    if (ownKey === key) return own
    return first.get(key) ?? (ownKey !== undefined && pkgId12(ownKey) === pkgId12(key) ? own : firstOfId.get(pkgId12(key)))
  }
  const direct = new Map([['.', new Map(placed.values().filter((node) => node.modules === 'node_modules').map((node) => [node.alias, node.dir]))]])
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    if (id === '.' || importer.made) continue
    const deps = new Map()
    for (const [alias, key] of dependenciesOf(importer)) {
      const dir = key.startsWith('link:') ? undefined : directOf(`${modulesOf(id)}/${alias}`, key)
      if (dir !== undefined) deps.set(alias, dir)
    }
    direct.set(id, deps)
  }
  return { placed, direct, skipped: left }
}

// What each project links, by where, and the copies then: a dependency in no node_modules it resolves from
// (direct_links.rs), named projects as for pnpm 11, and `link:`s, a copy there moved to .ignored_<name> beside
// it (symlink_dir/replace.rs); `resolved`, by node_modules, what each project's bins are linked of, twice
export function hoistedLinks12(lockfile, { placed, direct, skipped }, settings, names) {
  const links = new Map()
  for (const [id, deps] of direct) {
    if (id === '.') continue
    for (const [alias, dir] of deps) {
      const path = `${modulesOf(id)}/${alias}`
      if (dir === `node_modules/${alias}` || dir === path) continue
      checkAlias(alias, modulesOf(id))
      if (placed.has(path)) throw new DeptreeError(`pnpm 12 puts a copy of ${quote(placed.get(path).key)} here, and links over it the one it depends on, which is not supported`, quote(path))
      links.set(path, dir)
    }
  }
  const ordered = new Map([...names].sort(([, a], [, b]) => compareNames(a, b)))
  for (const [path, id] of workspaceHoists(placed, lockfile, settings, ordered)) links.set(path, id)
  const moved = new Map()
  for (const [path, target] of projectLinks(lockfile)) {
    if (placed.has(path)) moved.set(path, `${dirname(path)}/.ignored_${basename(path)}`)
    links.set(path, target)
  }
  const to = (dir) => {
    for (const [from, into] of moved) if (within(from, dir)) return `${into}${dir.slice(from.length)}`
    return dir
  }
  for (const [path, target] of links) {
    if (to(target) !== target) throw new DeptreeError(`pnpm 12 links it to ${quote(target)}, which it then moves aside for a project's link, which is not supported`, quote(path))
  }
  const copies = moved.size === 0 ? placed : new Map(placed.values().map((node) => [to(node.dir), { ...node, dir: to(node.dir), modules: to(node.modules) }]))
  const resolved = [...direct].map(([id, deps]) => ({ modules: modulesOf(id), dirs: [...deps].filter(([alias, dir]) => dir === `${modulesOf(id)}/${alias}` || links.has(`${modulesOf(id)}/${alias}`)).map(([, dir]) => to(dir)) }))
  const resolves = (path) => links.get(path) ?? (copies.has(path) ? path : undefined)
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    resolved.push({ modules: modulesOf(id), dirs: dependenciesOf(importer).filter(([, key]) => !skipped.has(key)).map(([alias]) => resolves(`${modulesOf(id)}/${alias}`)).filter((dir) => dir !== undefined) })
  }
  return { placed: copies, links, resolved }
}

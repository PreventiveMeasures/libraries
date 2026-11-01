// A module's package, as Metro finds and reads it: the closest package.json
// (its file map's hierarchicalLookup and its PackageCache), its legacy
// "browser"-spec redirects (metro-resolver's PackageResolve), and its entry
// point. Mirrors metro-resolver 0.87.2 and Metro 0.87, MIT licensed,
// Copyright (c) Meta Platforms, Inc. and affiliates.

import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

import { readManifest } from '../host.js'

const toPosix = (path) => (sep === '/' ? path : path.replaceAll(sep, '/'))

// The packages of a tree read through `host`, each manifest read once, for
// `mainFields`: a tree that changes needs a new one.
export function createPackages(host, mainFields) {
  const manifests = new Map()
  const read = (file) => {
    if (!manifests.has(file)) manifests.set(file, readManifest(host, file))
    return manifests.get(file)
  }
  const exists = (path) => host.isFile(path) || host.isDirectory(path)
  const redirects = new WeakMap()
  // A package's root by its real path, as Metro's file map spells a
  // directory it found: what its redirects are joined to.
  const roots = new Map()
  const rootOf = (dir) => {
    if (!roots.has(dir)) roots.set(dir, host.realpath(dir))
    return roots.get(dir)
  }

  // The package closest to `path`, which need not exist: { rootPath,
  // packageJson, packageRelativePath }, or null. A directory's own
  // package.json is its own; past that, the directories above as `path`
  // spells them, but none past a `node_modules` (a package does not hold the
  // one it is installed in). The lookup starts at the deepest directory
  // there: one missing on the way, named node_modules, finds no package
  // either.
  function forModule(path) {
    if (host.isDirectory(path) && host.isFile(join(path, 'package.json'))) {
      return { rootPath: rootOf(path), packageJson: read(join(path, 'package.json')), packageRelativePath: '' }
    }
    let below = path
    if (!exists(path)) {
      while (dirname(below) !== below && !exists(dirname(below))) below = dirname(below)
      if (basename(below) === 'node_modules') return null
    }
    for (let dir = dirname(below); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
      const file = join(dir, 'package.json')
      if (host.isFile(file)) return { rootPath: rootOf(dir), packageJson: read(file), packageRelativePath: relative(dir, path) }
      if (dirname(dir) === dir) break
    }
    return null
  }

  // The object-valued mainFields of `pkg` as one map, earlier fields winning,
  // or null where it has none. A value neither a string nor false redirects
  // nothing.
  function redirectsOf(pkg) {
    if (redirects.has(pkg)) return redirects.get(pkg)
    let map = null
    for (const field of mainFields.toReversed()) {
      const value = pkg[field]
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      map ??= new Map()
      for (const [key, to] of Object.entries(value)) {
        if (typeof to === 'string' || to === false) map.set(key, to)
        else map.delete(key)
      }
    }
    redirects.set(pkg, map)
    return map
  }

  // What `pkg`'s redirects map `subpath` to: a string, false (an empty
  // module), or null for no entry. A subpath is tried as it is, then with
  // `.js` and `.json` added; an array of variants is tried as given.
  function match(subpath, pkg) {
    const map = redirectsOf(pkg)
    if (map === null) return null
    for (const variant of Array.isArray(subpath) ? subpath : [subpath, `${subpath}.js`, `${subpath}.json`]) {
      if (map.has(variant)) return map.get(variant)
    }
    return null
  }

  // The absolute `path` as the redirects of the package closest to it map it,
  // by its package-relative spelling: a path, or false (an empty module). A
  // string is taken as relative to the package even where it names another.
  function redirect(path) {
    const pkg = forModule(path)
    if (pkg === null) return path
    const to = match(`./${toPosix(pkg.packageRelativePath)}`, pkg.packageJson)
    if (typeof to !== 'string') return to ?? path
    return isAbsolute(to) ? normalize(to) : join(pkg.rootPath, to)
  }

  // The package's main module, from `pkg`'s first mainField naming one, else
  // `index`, through its redirects. The first of its spellings with an entry
  // decides, a false entry keeping it as it is.
  function entryPoint(pkg) {
    const main = mainFields.map((field) => pkg[field]).find((value) => typeof value === 'string' && value.length > 0) ?? 'index'
    const variants = [main, main.startsWith('./') ? main.slice(2) : `./${main}`]
      .flatMap((variant) => [variant, `${variant}.js`, `${variant}.json`, variant.replace(/\.js$|\.json$/u, '')])
    const to = match(variants, pkg)
    return typeof to === 'string' ? to : main
  }

  return { read, forModule, match, redirect, entryPoint }
}

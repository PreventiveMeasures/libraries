// A module's package, as Metro finds and reads it: the closest package.json
// (its file map's hierarchicalLookup and its PackageCache), its legacy
// "browser"-spec redirects (metro-resolver's PackageResolve), and its entry
// point. Mirrors metro-resolver 0.87.2 and Metro 0.87, MIT licensed,
// Copyright (c) Meta Platforms, Inc. and affiliates.

import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

export const toPosix = (path) => path.replaceAll(sep, '/')

// `dir` and each directory above it, up to the root.
export function* selfAndAncestors(dir) {
  for (let at = dir; ; at = dirname(at)) {
    yield at
    if (dirname(at) === at) return
  }
}

// A subpath as the "browser" spec matches it: as it is, with `.js`, with `.json`.
const variants = (subpath) => [subpath, `${subpath}.js`, `${subpath}.json`]

const memo = (map, key, make) => {
  if (!map.has(key)) map.set(key, make())
  return map.get(key)
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The manifest at `file`, parsed. One that is there but is no JSON object
// fails the resolution rather than being passed by, as Metro's package cache
// throws on it.
function readManifest(host, file) {
  let manifest
  try {
    manifest = JSON.parse(decoder.decode(host.readFile(file)))
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`Invalid package.json: ${file}: not an object`)
  return manifest
}

// The packages of a tree read through `host`, each manifest read once, for
// `mainFields`: a tree that changes needs a new one.
export function createPackages(host, mainFields) {
  const manifests = new Map()
  const roots = new Map()
  const redirects = new WeakMap()
  const read = (file) => memo(manifests, file, () => readManifest(host, file))
  // A package's root by its real path, as Metro's file map spells a directory
  // it found: what its redirects are joined to.
  const found = (dir, path) => ({ rootPath: memo(roots, dir, () => host.realpath(dir)), packageJson: read(join(dir, 'package.json')), packageRelativePath: toPosix(relative(dir, path)) })

  // The package closest to `path`, which need not exist: { rootPath,
  // packageJson, packageRelativePath (posix) }, or null. A directory's own
  // package.json is its own; past that, the directories above as `path`
  // spells them, but none past a `node_modules` (a package does not hold the
  // one it is installed in). The lookup starts at the deepest directory
  // there: one missing on the way, named node_modules, finds no package
  // either.
  function forModule(path) {
    const isDirectory = host.isDirectory(path)
    if (isDirectory && host.isFile(join(path, 'package.json'))) return found(path, path)
    let below = path
    if (!isDirectory && !host.isFile(path)) {
      while (dirname(below) !== below && !host.isDirectory(dirname(below))) below = dirname(below)
      if (basename(below) === 'node_modules') return null
    }
    for (const dir of selfAndAncestors(dirname(below))) {
      if (basename(dir) === 'node_modules') return null
      if (host.isFile(join(dir, 'package.json'))) return found(dir, path)
    }
    return null
  }

  // The object-valued mainFields of `pkg` as one map, earlier fields winning,
  // or null where it has none. A value neither a string nor false redirects
  // nothing.
  function redirectsOf(pkg) {
    return memo(redirects, pkg, () => {
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
      return map
    })
  }

  // What `pkg`'s redirects map the first of `subpaths` they have to: a string,
  // false (an empty module), or null for none.
  function match(subpaths, pkg) {
    const map = redirectsOf(pkg)
    const key = map === null ? undefined : subpaths.find((subpath) => map.has(subpath))
    return key === undefined ? null : map.get(key)
  }

  // A bare specifier as the redirects of `pkg` map it.
  const matchSpecifier = (specifier, pkg) => match(variants(specifier), pkg)

  // The absolute `path` as the redirects of the package closest to it map it,
  // by its package-relative spelling: a path, or false (an empty module). A
  // string is taken as relative to the package even where it names another.
  function redirect(path) {
    const pkg = forModule(path)
    if (pkg === null) return path
    const to = match(variants(`./${pkg.packageRelativePath}`), pkg.packageJson)
    if (typeof to !== 'string') return to ?? path
    return isAbsolute(to) ? normalize(to) : join(pkg.rootPath, to)
  }

  // The package's main module, from `pkg`'s first mainField naming one, else
  // `index`, through its redirects. The first of its spellings with an entry
  // decides, a false entry keeping it as it is.
  function entryPoint(pkg) {
    const main = mainFields.map((field) => pkg[field]).find((value) => typeof value === 'string' && value.length > 0) ?? 'index'
    const spellings = [main, main.startsWith('./') ? main.slice(2) : `./${main}`]
      .flatMap((spelling) => [...variants(spelling), spelling.replace(/\.js$|\.json$/u, '')])
    const to = match(spellings, pkg)
    return typeof to === 'string' ? to : main
  }

  return { read, forModule, matchSpecifier, redirect, entryPoint }
}

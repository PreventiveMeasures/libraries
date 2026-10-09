import { posix } from 'node:path'

// A `sources` entry as a path, and the package it lies in where the path
// runs through node_modules. Paths are /-separated whatever wrote them.

const WEBPACK = /^webpack(?:-internal)?:\/\/[^/]*\//u
const SCHEME = /^[a-z][\d+.a-z-]*:/iu
const DRIVE = /^[a-z]:\//iu

// A package installed by name inside a node_modules directory. An npm name
// is never `.`-led (.bin, .pnpm, .vite are the tools' own directories).
const NAME = /^(?:@[^./][^/]*\/)?[^./][^/]*$/u
// Stores that keep each package at <name>@<version>[peers]/node_modules/<name>:
// pnpm's virtual store, and bun's and deno's on the same plan.
const STORES = new Set(['.pnpm', '.bun', '.deno'])
const SEMVER = /^\d+\.\d+\.\d+(?:-[\d.a-z-]+)?(?:\+[\d.a-z-]+)?$/iu

function absolute(path) {
  return path.startsWith('/') || DRIVE.test(path)
}

// webpack:// names a file from webpack's context, not from the map, so it
// is not resolved against the map's own path; file:// is a path already.
// Any other scheme is a URL or a bundler's own name for something that is
// not a file, and is kept as it is.
export function sourcePath(source, mapPath) {
  let path = source.replaceAll('\\', '/')
  if (WEBPACK.test(path)) return posix.normalize(path.replace(WEBPACK, ''))
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.slice('file://'.length).replace(/^[^/]*/u, ''))
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1)
  } else if (SCHEME.test(path) && !DRIVE.test(path)) {
    return path
  }
  if (mapPath !== undefined && !absolute(path)) path = posix.join(posix.dirname(mapPath.replaceAll('\\', '/')), path)
  return posix.normalize(path)
}

// The version a store's directory name spells for `name`: pnpm writes
// `@scope+name@1.2.3`, then peers after `_` (pnpm 8) or in parentheses
// (pnpm 9), and a long one cut short with a hash after `_`.
function storeVersion(dir, name) {
  const prefix = `${name.replace('/', '+')}@`
  if (!dir.startsWith(prefix)) return null
  const version = dir.slice(prefix.length).split(/[(_]/u)[0]
  return SEMVER.test(version) ? version : null
}

// The package `path` lies in, as the last node_modules on it names it, or
// null: { name, version, root, path } with `root` the package's directory
// and `path` the file's path inside it. The version where a store spells it.
export function packageOf(path) {
  const parts = path.split('/')
  const at = parts.lastIndexOf('node_modules')
  if (at < 0) return null
  const scoped = parts[at + 1]?.startsWith('@')
  const width = scoped ? 2 : 1
  const name = parts.slice(at + 1, at + 1 + width).join('/')
  const inside = parts.slice(at + 1 + width)
  if (!NAME.test(name) || inside.length === 0 || inside.includes('')) return null
  const store = at >= 2 && STORES.has(parts[at - 2])
  return {
    name,
    version: store ? storeVersion(parts[at - 1], name) : null,
    root: parts.slice(0, at + 1 + width).join('/'),
    path: inside.join('/'),
  }
}

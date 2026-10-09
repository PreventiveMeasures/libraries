import { posix } from 'node:path'

// A `sources` entry as a path, and the package it lies in where the path
// runs through node_modules. Paths are /-separated whatever wrote them.

const WEBPACK = /^webpack(?:-internal)?:\/\/[^/]*\//u
const SCHEME = /^[a-z][\d+.a-z-]*:/iu
const DRIVE = /^[a-z]:\//iu
// A URL's scheme and host: its root, kept apart so that what follows is
// joined and normalized as a POSIX path, with nothing above it to climb to.
const ORIGIN = /^[a-z][\d+.a-z-]*:\/\/[^/]*/iu

function split(path) {
  const origin = ORIGIN.exec(path)?.[0] ?? ''
  return [origin, path.slice(origin.length) || (origin ? '/' : '')]
}

export function normalize(path) {
  const [origin, rest] = split(path)
  return origin + posix.normalize(rest)
}

export function dirname(path) {
  const [origin, rest] = split(path)
  return origin + posix.dirname(rest)
}

export const isUrl = (path) => ORIGIN.test(path)

// `relative` from the directory `dir`; a `/`-led one from the root of `dir`,
// a URL's own or the file system's; a URL as it is.
export function join(dir, relative) {
  if (isUrl(relative)) return normalize(relative)
  const [origin, rest] = split(dir)
  return origin + (relative.startsWith('/') ? posix.normalize(relative) : posix.join(rest, relative))
}

const absolute = (path) => path.startsWith('/') || DRIVE.test(path) || isUrl(path)

// webpack:// names a file from webpack's context, not from the map, so it
// is not resolved against the map's own path; file:// is a path already.
// A URL is one too, under its scheme and host. Any other scheme is a name
// a bundler gave something that is not a file (data:, a virtual module),
// kept as it is.
export function sourcePath(source, mapPath) {
  let path = source.replaceAll('\\', '/')
  if (WEBPACK.test(path)) return normalize(path.replace(WEBPACK, ''))
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.slice('file://'.length).replace(/^[^/]*/u, ''))
    if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1)
  } else if (SCHEME.test(path) && !isUrl(path) && !DRIVE.test(path)) {
    return path
  }
  if (mapPath !== undefined && !absolute(path)) path = join(dirname(mapPath.replaceAll('\\', '/')), path)
  return normalize(path)
}

// npm's rule for a name, scoped or not, as lockfile holds it: ASCII, and
// never `.`- or `_`-led (.bin, .pnpm, .vite are the tools' own directories).
const NAME = /^(?:@[\dA-Za-z~-][\w.~-]*\/)?[\dA-Za-z~-][\w.~-]*$/u

// The package a bare specifier, or a path from inside node_modules, starts
// with; null for one that names none (a tsconfig alias such as `@/x`, a
// `#subpath` import, a relative path).
export function packageName(specifier) {
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  return NAME.test(name) ? name : null
}

// Stores that keep each package at <name>@<version>[peers]/node_modules/<name>:
// pnpm's virtual store, and bun's and deno's on the same plan.
const STORES = new Set(['.pnpm', '.bun', '.deno'])
const SEMVER = /^\d+\.\d+\.\d+(?:-[\d.a-z-]+)?(?:\+[\d.a-z-]+)?$/iu

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
  const name = at < 0 ? null : packageName(parts.slice(at + 1).join('/'))
  if (name === null) return null
  const end = at + 1 + (name.startsWith('@') ? 2 : 1)
  const inside = parts.slice(end)
  if (inside.length === 0 || inside.includes('')) return null
  return {
    name,
    version: at >= 2 && STORES.has(parts[at - 2]) ? storeVersion(parts[at - 1], name) : null,
    root: parts.slice(0, end).join('/'),
    path: inside.join('/'),
  }
}

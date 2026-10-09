const WEBPACK = /^webpack(?:-internal)?:\/\/[^/]*\//u
const SCHEME = /^[a-z][\d+.a-z-]*:/iu
const DRIVE = /^[a-z]:\//iu
// A URL's scheme and host, which no `..` climbs above.
const ORIGIN = /^[a-z][\d+.a-z-]*:\/\/[^/]*/iu

export const isUrl = (path) => ORIGIN.test(path)

// By spelling alone, as node:path.posix normalizes: a `..` above a relative
// path is kept.
function normalize(path) {
  const origin = ORIGIN.exec(path)?.[0] ?? ''
  const rest = path.slice(origin.length)
  const absolute = origin !== '' || rest.startsWith('/')
  const out = []
  for (const part of rest.split('/')) {
    if (part === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (part === '..' ? !absolute : part !== '' && part !== '.') out.push(part)
  }
  return origin + (absolute ? '/' : '') + out.join('/') || '.'
}

// `relative` from the file `from`; a `/`-led one from the root of `from`'s.
export function resolvePath(from, relative) {
  if (isUrl(relative)) return normalize(relative)
  if (relative.startsWith('/')) return normalize((ORIGIN.exec(from)?.[0] ?? '') + relative)
  return normalize(`${from}/../${relative}`)
}

// webpack:// paths are from webpack's context, not from the map. Other
// schemes but file:// and URLs' name no file (data:, a virtual module).
export function sourcePath(source, mapPath) {
  let path = source.replaceAll('\\', '/')
  if (WEBPACK.test(path)) return normalize(path.replace(WEBPACK, ''))
  if (path.startsWith('file://')) path = decodeURIComponent(path.slice(7).replace(/^[^/]*/u, '')).replace(/^\/(?=[a-z]:\/)/iu, '')
  else if (SCHEME.test(path) && !isUrl(path) && !DRIVE.test(path)) return path
  const absolute = path.startsWith('/') || DRIVE.test(path) || isUrl(path)
  return mapPath === undefined || absolute ? normalize(path) : resolvePath(mapPath.replaceAll('\\', '/'), path)
}

// npm's rule, as lockfile holds it: ASCII, and never `.`- or `_`-led, which
// leaves out the tools' own directories (.bin, .pnpm, .vite).
const NAME = /^(?:@[\dA-Za-z~-][\w.~-]*\/)?[\dA-Za-z~-][\w.~-]*$/u

export function packageName(specifier) {
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  return NAME.test(name) ? name : null
}

// Stores that keep a package at <name>@<version><peers>/node_modules/<name>,
// a scope's `/` spelled `+`, peers after `_` (pnpm 8) or in parentheses.
const STORES = new Set(['.pnpm', '.bun', '.deno'])
const SEMVER = /^\d+\.\d+\.\d+(?:-[\d.a-z-]+)?(?:\+[\d.a-z-]+)?$/iu

function storeVersion(dir, name) {
  const prefix = `${name.replace('/', '+')}@`
  const version = dir.startsWith(prefix) ? dir.slice(prefix.length).split(/[(_]/u)[0] : null
  return SEMVER.test(version) ? version : null
}

export function packageOf(path) {
  const parts = path.split('/')
  const at = parts.lastIndexOf('node_modules')
  const name = at < 0 ? null : packageName(parts.slice(at + 1).join('/'))
  const end = at + 1 + (name?.startsWith('@') ? 2 : 1)
  if (name === null || end >= parts.length || parts.slice(end).includes('')) return null
  return {
    name,
    version: STORES.has(parts[at - 2]) ? storeVersion(parts[at - 1], name) : null,
    root: parts.slice(0, end).join('/'),
    path: parts.slice(end).join('/'),
  }
}

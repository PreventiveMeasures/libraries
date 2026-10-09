export const WEBPACK = /^webpack(?:-internal)?:\/\/[^/]*\//u
const SCHEME = /^[a-z][\d+.a-z-]*:/iu
// What no `..` climbs above: a URL's scheme and host, a drive, `/`.
const ROOT = /^(?:[a-z][\d+.a-z-]*:\/\/[^/]*\/?|[a-z]:\/|\/)?/iu

const rootOf = (path) => ROOT.exec(path)[0]

export const isUrl = (path) => rootOf(path).includes('://')

// By spelling alone, as node:path.posix normalizes: a `..` above a relative
// path is kept.
function normalize(path) {
  const root = rootOf(path)
  const out = []
  for (const part of path.slice(root.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') out.push(part)
    else if (out.length > 0 && out.at(-1) !== '..') out.pop()
    else if (!root) out.push('..')
  }
  return root ? root.replace(/\/?$/u, '/') + out.join('/') : out.join('/') || '.'
}

// `relative` from the file `from`; a `/`-led one from the root of `from`'s,
// a `//`-led one, from a URL, under its scheme.
export function resolvePath(from, relative) {
  if (relative.startsWith('//') && isUrl(from)) return normalize(from.slice(0, from.indexOf(':') + 1) + relative)
  const root = rootOf(relative)
  if (root === '/') return normalize(rootOf(from).replace(/\/?$/u, '') + relative)
  return normalize(root ? relative : `${from}/../${relative}`)
}

// webpack:// paths are from webpack's context, not from the map. A scheme
// with no root (data:, a virtual module) names no file.
export function sourcePath(source, mapPath) {
  let path = source.replaceAll('\\', '/')
  if (WEBPACK.test(path)) return normalize(path.replace(WEBPACK, ''))
  if (path.startsWith('file://')) path = decodeURIComponent(path.slice(7).replace(/^[^/]*/u, '')).replace(/^\/(?=[a-z]:\/)/iu, '')
  else if (SCHEME.test(path) && !rootOf(path).includes(':')) return path
  return mapPath === undefined || rootOf(path) ? normalize(path) : resolvePath(mapPath.replaceAll('\\', '/'), path)
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
  if (name === null) return null
  const end = at + 1 + name.split('/').length
  if (end >= parts.length || parts.slice(end).includes('')) return null
  return {
    name,
    version: STORES.has(parts[at - 2]) ? storeVersion(parts[at - 1], name) : null,
    root: parts.slice(0, end).join('/'),
    path: parts.slice(end).join('/'),
  }
}

// The .js family with JSX, as React Native writes it, which plain
// JavaScript parses the same under.
const LANGUAGES = new Map([['js', 'jsx'], ['mjs', 'jsx'], ['cjs', 'jsx'], ['jsx', 'jsx'], ['es', 'jsx'], ['es6', 'jsx'], ['ts', 'ts'], ['mts', 'ts'], ['cts', 'ts'], ['tsx', 'tsx'], ['json', 'json']])

// By the extension, a bundler's `?query` after it aside; a file named with
// none, a bin script, as JavaScript.
export function languageOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\?.*$/su, '')
  if (/^[\w-]+$/u.test(name)) return 'jsx'
  return LANGUAGES.get(/\.([\da-z]+)$/iu.exec(name)?.[1].toLowerCase()) ?? null
}

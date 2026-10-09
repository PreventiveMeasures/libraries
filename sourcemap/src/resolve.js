import { isUrl, packageName, resolvePath } from './files.js'

// A map holds no package.json, tsconfig or resolver settings, so a file is
// found by the names a resolver would try for it: no `exports`, `main` or
// aliases.

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json']
// React Native's platform files, which Metro picks over the plain one.
const PLATFORMS = ['', '.native', '.ios', '.android', '.web']
// TypeScript's sources, imported by the names they compile to.
const OUTPUT_NAMES = [['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]]

function* candidates(base) {
  yield base
  for (const [output, inputs] of OUTPUT_NAMES) {
    if (base.endsWith(output)) for (const input of inputs) yield base.slice(0, -output.length) + input
  }
  for (const stem of [base, `${base}/index`]) {
    for (const platform of PLATFORMS) for (const extension of EXTENSIONS) yield stem + platform + extension
  }
}

// Each package's directories by name: copies of different versions can lie
// in several.
export function indexFiles(files) {
  const byPath = new Map()
  const roots = new Map()
  for (const file of files) {
    if (file.path !== null) byPath.set(file.path, file)
    if (file.package) roots.set(file.package.name, (roots.get(file.package.name) ?? new Set()).add(file.package.root))
  }
  return { byPath, roots }
}

function find(index, base) {
  for (const candidate of candidates(base)) if (index.byPath.has(candidate)) return index.byPath.get(candidate)
  return null
}

// As Node walks up from a file; else, as a store keeps packages away from
// their importers (pnpm's paths are real paths, not the links beside
// them), the one copy the map has.
function packageRoot(index, from, name) {
  const dirs = index.roots.get(name)
  if (!dirs) return null
  const parts = from.path.split('/')
  for (let k = parts.length - 1; k >= 0; k--) {
    const root = [...parts.slice(0, k), 'node_modules', name].join('/')
    if (dirs.has(root)) return root
  }
  return dirs.size === 1 ? [...dirs][0] : null
}

// Node's own, under their bare names; a fixed list, so that what a map says
// does not hang on the Node that reads it.
const BUILTINS = new Set(['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'])

export function bareTarget(specifier) {
  if (specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0])) return { builtin: true }
  const name = packageName(specifier)
  return name === null ? {} : { package: name }
}

export function resolveSpecifier(index, from, specifier) {
  if (/^(?:\.{1,2}(?:\/|$)|\/)/u.test(specifier) || isUrl(specifier)) {
    const path = resolvePath(from.path, specifier)
    const to = find(index, path)
    return to ? { to } : { to: null, path }
  }
  const name = packageName(specifier)
  const root = name === null ? null : packageRoot(index, from, name)
  if (root === null) return { to: null, ...bareTarget(specifier) }
  const to = find(index, root + specifier.slice(name.length))
  return to ? { to } : { to: null, package: name }
}

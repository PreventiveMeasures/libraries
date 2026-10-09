import { isUrl, packageName, resolvePath, sourcePath } from './files.js'

// A map holds no package.json, tsconfig or resolver settings, so a file is
// found by the names a resolver would try for it, and a package's entry by
// where packages keep it: no `exports`, and no aliases.

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json']
// React Native's platforms: Metro tries the bundle's own, then `.native`,
// then the plain file, and never another platform's. A map's platform is
// the one its files show more of than any other; a map that shows none, or
// two as much, tries `.native`, then the plain file. A browser or Node
// build a package ships beside the plain file comes after it.
const RN_PLATFORMS = ['.ios', '.android', '.web']

function platformsOf(files) {
  const counts = RN_PLATFORMS.map((platform) => [platform, files.filter((file) => file.path?.includes(`${platform}.`)).length]).toSorted((a, b) => b[1] - a[1])
  const [[active, count], [, next]] = counts
  return [...(count === next ? [] : [active]), '.native', '', '.browser', '.node']
}
// TypeScript's sources, imported by the names they compile to.
const OUTPUT_NAMES = new Map([['.js', ['.ts', '.tsx']], ['.jsx', ['.tsx']], ['.mjs', ['.mts']], ['.cjs', ['.cts']]])
// Where a package keeps the entry its package.json, which no map carries,
// names.
const ENTRY_NAMES = ['index', 'main', 'browser', 'node']
const ENTRY_DIRS = ['', 'src/', 'lib/', 'dist/', 'build/']
// What a package publishes compiled out of src/, or out of its root.
const BUILD_DIRS = new Set(['lib', 'dist', 'build', 'out', 'esm', 'cjs'])

function* candidates(base, platforms) {
  yield base
  const written = /\.[^./]+$/u.exec(base)?.[0]
  for (const input of OUTPUT_NAMES.get(written) ?? []) yield base.slice(0, -written.length) + input
  for (const stem of [base, `${base}/index`]) {
    for (const platform of platforms) for (const extension of EXTENSIONS) yield stem + platform + extension
  }
  // `./a.js` as a platform's own: ./a.browser.js.
  if (written) for (const platform of platforms.filter(Boolean)) yield base.slice(0, -written.length) + platform + written
}

// A compiled package's subpath where the map holds its sources instead:
// lib/a.js as src/a.ts, dist/esm/a.js as src/a.ts or a.ts.
function* sourcePaths(subpath) {
  let rest = subpath
  for (;;) {
    if (!rest.startsWith('src/')) yield `src/${rest}`
    if (rest !== subpath) yield rest
    const slash = rest.indexOf('/')
    if (slash < 0 || !BUILD_DIRS.has(rest.slice(0, slash))) return
    rest = rest.slice(slash + 1)
  }
}

// Each package's directories by name: copies of different versions can lie
// in several. `found`: what each path a specifier named resolved to, as
// many files name the same.
export function indexFiles(files) {
  const byPath = new Map()
  const roots = new Map()
  const byRoot = new Map()
  for (const file of files) {
    if (file.path !== null) byPath.set(file.path, file)
    if (!file.package) continue
    roots.set(file.package.name, (roots.get(file.package.name) ?? new Set()).add(file.package.root))
    const inRoot = byRoot.get(file.package.root) ?? byRoot.set(file.package.root, []).get(file.package.root)
    inRoot.push(file)
  }
  return { byPath, roots, byRoot, platforms: platformsOf(files), found: new Map() }
}

function find(index, base) {
  if (!index.found.has(base)) index.found.set(base, index.byPath.get(candidates(base, index.platforms).find((candidate) => index.byPath.has(candidate))) ?? null)
  return index.found.get(base)
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

export const externalEdge = (from, kind, specifier) => ({ from, to: null, kind, specifier, ...(specifier !== null && bareTarget(specifier)) })

// Edges kept once per file they lead from and `key`.
export function edgeList() {
  const edges = []
  const seen = new Map()
  const add = (from, key, edge) => {
    const keys = seen.get(from) ?? seen.set(from, new Set()).get(from)
    if (keys.has(key)) return
    keys.add(key)
    edges.push(edge)
  }
  return { edges, add }
}

// A package's entry, where no index file at its root is: index, main,
// browser or node, at its root or in a build directory; else its one file.
function entryOf(index, root) {
  for (const name of ENTRY_NAMES) {
    for (const dir of ENTRY_DIRS) {
      const to = find(index, `${root}/${dir}${name}`)
      if (to) return to
    }
  }
  const files = index.byRoot.get(root)
  return files?.length === 1 ? files[0] : null
}

// Where a map lists files in the order a bundler reached them, a package's
// first is its entry.
export const entryInOrder = (index, root) => index.byRoot.get(root)[0]

function packageFile(index, root, subpath, entry) {
  if (!subpath) return find(index, root) ?? entry(index, root)
  return find(index, `${root}/${subpath}`) ?? sourcePaths(subpath).map((path) => find(index, `${root}/${path}`)).find(Boolean)
}

// `entry` finds a package's entry where no index file at its root is.
export function resolveSpecifier(index, from, specifier, entry = entryOf) {
  // Node on Windows takes `.\a` and `C:\a` as paths, written as the map's own are.
  const request = /^(?:\.{1,2}|[a-z]:)?\\/iu.test(specifier) ? specifier.replaceAll('\\', '/') : specifier
  if (/^(?:\.{1,2}(?:\/|$)|\/|[a-z]:\/)/iu.test(request) || isUrl(request)) {
    // A file:// URL as the map's own sources are: a path.
    const path = /^file:\/\//iu.test(request) ? sourcePath(request) : resolvePath(from.path, request)
    const to = find(index, path)
    return to ? { to } : { to: null, path }
  }
  // A source the map keeps under an opaque scheme, `virtual:a`, by that name.
  if (/^[a-z][\d+.a-z-]*:/iu.test(request) && index.byPath.has(request)) return { to: index.byPath.get(request) }
  const name = packageName(specifier)
  const root = name === null ? null : packageRoot(index, from, name)
  if (root === null) return { to: null, ...bareTarget(specifier) }
  const to = packageFile(index, root, specifier.slice(name.length + 1), entry)
  return to ? { to } : { to: null, package: name }
}

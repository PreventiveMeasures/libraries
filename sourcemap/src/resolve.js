import { isBuiltin } from 'node:module'
import { posix } from 'node:path'

// A specifier resolved among the files one map lists, as far as those can
// tell it: the map holds no package.json, no tsconfig and no resolver
// settings, so a file is found by the names a resolver would try for it.

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

// The files of one map by path, and each package's directories by name:
// one package can lie in several, as copies of different versions.
export function indexFiles(files) {
  const byPath = new Map()
  const roots = new Map()
  for (const file of files) {
    if (file.path === null) continue
    byPath.set(file.path, file)
    if (file.package) {
      const dirs = roots.get(file.package.name) ?? roots.set(file.package.name, new Set()).get(file.package.name)
      dirs.add(file.package.root)
    }
  }
  return { byPath, roots }
}

function find(index, base) {
  for (const candidate of candidates(base)) {
    const file = index.byPath.get(candidate)
    if (file) return file
  }
  return null
}

const RELATIVE = /^\.\.?(?:\/|$)/u
// An npm name, scoped or not: URL-safe characters, not `.`- or `_`-led.
const PACKAGE = /^(?:@[\da-z~-][\w.~-]*\/)?[\da-z~-][\w.~-]*$/iu

// The package a bare specifier names, or null for one that names none
// (a tsconfig alias such as `@/x`, a `#subpath` import).
export function packageName(specifier) {
  const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  return PACKAGE.test(name) ? name : null
}

// The directory `name` resolves to from `from`, as Node walks up from a
// file; or, where the store keeps packages away from their importers (a
// pnpm path is a real path, not the link beside the importer), the one
// directory the map has for it.
function packageRoot(index, from, name) {
  const dirs = index.roots.get(name)
  if (!dirs) return null
  for (let dir = posix.dirname(from.path); ; ) {
    const root = posix.join(dir, 'node_modules', name)
    if (dirs.has(root)) return root
    const up = posix.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return dirs.size === 1 ? [...dirs][0] : null
}

// Where `specifier`, imported from `from`, leads: { to } a file of the map,
// else { to: null } with what the specifier names — `path` for a relative
// one, `package` for a bare one, `builtin` for one of Node's own modules.
export function resolveSpecifier(index, from, specifier) {
  if (RELATIVE.test(specifier) || specifier.startsWith('/')) {
    const base = specifier.startsWith('/') ? posix.normalize(specifier) : posix.join(posix.dirname(from.path), specifier)
    const to = find(index, base)
    return to ? { to } : { to: null, path: base }
  }
  const name = packageName(specifier)
  const root = name === null ? null : packageRoot(index, from, name)
  if (root !== null) {
    const to = find(index, root + specifier.slice(name.length))
    return to ? { to } : { to: null, package: name }
  }
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return { to: null, builtin: true }
  return name === null ? { to: null } : { to: null, package: name }
}

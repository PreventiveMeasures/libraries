// Overrides as pnpm 10 reads them. The root package.json gives Yarn's
// `resolutions` and its own `pnpm.overrides`, the second winning a
// selector both name; where the two name any, they are the overrides,
// and pnpm-workspace.yaml's are passed over whole, as `pnpm install`
// spreads the package.json's settings over the rest. Only where the
// package.json names none are pnpm-workspace.yaml's `overrides` read. In
// each, a value of `$name` is the specifier
// the root package.json gives its own dependency `name` (optional over
// regular over dev), and one of `catalog:` or `catalog:<name>` is what
// that catalog gives the package the selector targets. A selector is a
// package, `name` or `name@range`, and may lead with its parent and a
// `>`: `bar@2>foo@1`. Anything pnpm cannot read — a selector it cannot
// parse, a `$name` with no such dependency, a catalog without the entry,
// or with one it refuses — is refused the same.
//
// The overrides are what the lockfile was resolved with, which is where
// they did their work: with a frozen lockfile pnpm only holds them to the
// lockfile's `overrides` (uptodate.js), and resolves anew where they
// differ.
//
// An override to a directory — `link:`, `file:` or a path alone, such as
// `./vendor/foo` — names it from the lockfile's directory, and is read
// only from a Vfs given that holds it (tree.js): one outside the lockfile's
// directory, or from the root or the home directory, is refused.
//
// pnpm 11 reads them from pnpm-workspace.yaml alone, trims each selector,
// takes a catalog's `workspace:` entry, and reads `name@` with an exact
// version as converging: a dependency on `name` whose range takes that
// version is given it, where no other override is chosen. It refuses one
// with a parent and an empty range, and one whose version is not exact.

import { valid } from '@preventive/upstream/semver.js'
import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// validate-npm-package-name 5's validForOldPackages, which pnpm reads a
// selector's name by: what npm ever took as a name.
const SCOPED = /^(?:@([^/]+?)\/)?([^/]+?)$/u
export function validForOldPackages(name) {
  if (name === '' || name.startsWith('.') || name.startsWith('_') || name.trim() !== name) return false
  if (name.toLowerCase() === 'node_modules' || name.toLowerCase() === 'favicon.ico') return false
  if (encodeURIComponent(name) === name) return true
  const m = SCOPED.exec(name)
  return m !== null && encodeURIComponent(m[1]) === m[1] && encodeURIComponent(m[2]) === m[2]
}

// @pnpm/parse-wanted-dependency: a name, where what comes before the first
// `@` past the start is one, then what follows it.
function parseWanted(raw) {
  const at = raw.indexOf('@', 1)
  const name = at === -1 ? raw : raw.slice(0, at)
  return validForOldPackages(name) ? { name, range: at === -1 ? undefined : raw.slice(at + 1) } : undefined
}

// A `>` after anything but a space, `|` or `@` splits the parent from the
// package, as pnpm's DELIMITER_REGEX has it; `foo@>1` is one package.
const DELIMITER = /[^ @|]>/u

export function parseSelector(selector, where) {
  if (!selector.isWellFormed()) throw new DeptreeError(`pnpm cannot parse the selector ${quote(selector)}`, where)
  const split = selector.search(DELIMITER)
  const parts = split === -1 ? [selector] : [selector.slice(0, split + 1), selector.slice(split + 2)]
  const parsed = parts.map(parseWanted)
  if (parsed.includes(undefined)) throw new DeptreeError(`pnpm cannot parse the selector ${quote(selector)}`, where)
  return parsed.length === 1 ? { target: parsed[0] } : { parent: parsed[0], target: parsed[1] }
}

// A layer's overrides with each `$name` replaced; `manifest` is the root
// package.json as parsed.
export function replaceReferences(overrides, manifest, where) {
  const own = { ...manifest.devDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
  const replaced = Object.create(null)
  for (const [selector, spec] of Object.entries(overrides)) {
    if (typeof spec !== 'string') throw new DeptreeError(`expected a string for ${quote(selector)}`, where)
    if (!spec.startsWith('$')) { replaced[selector] = spec; continue }
    const found = Object.hasOwn(own, spec.slice(1)) ? own[spec.slice(1)] : undefined
    if (typeof found !== 'string' || found === '') throw new DeptreeError(`${quote(spec)} names no dependency of the root package.json`, where)
    replaced[selector] = found
  }
  return replaced
}

const CATALOG = 'catalog:'

// The catalog a `catalog:` specifier names, `default` where it names none,
// or undefined for another specifier.
export const catalogOf = (spec) => (spec.startsWith(CATALOG) ? spec.slice(CATALOG.length).trim() || 'default' : undefined)

// The entry catalog `catalog` of `catalogs` has for `name`, if any.
export const catalogEntry = (catalogs, catalog, name) => (Object.hasOwn(catalogs, catalog) && Object.hasOwn(catalogs[catalog], name) ? catalogs[catalog][name] : undefined)

// @pnpm/catalogs.resolver's resolveFromCatalog: the specifier a catalog
// gives `name`, where `spec` asks for one.
function fromCatalog(catalogs, spec, name, where, major) {
  const catalog = catalogOf(spec)
  if (catalog === undefined) return spec
  const found = catalogEntry(catalogs, catalog, name)
  const refused = found === undefined ? `catalog ${quote(catalog)} has no entry for ${quote(name)}`
    : found.startsWith(CATALOG) ? `the entry for ${quote(name)} in catalog ${quote(catalog)} is itself a catalog reference`
    : ['link', 'file', ...(major >= 11 ? [] : ['workspace'])].includes(found.split(':')[0]) ? `the entry for ${quote(name)} in catalog ${quote(catalog)} uses a protocol pnpm refuses in a catalog`
    : undefined
  if (refused !== undefined) throw new DeptreeError(`pnpm cannot resolve a catalog in the overrides: ${refused}`, where)
  return found
}

// The directory an override names, as pnpm's local resolver reads a
// specifier, and by which protocol, or undefined for one that is none.
export function localOf(spec, where) {
  const protocol = ['file:', 'link:'].find((prefix) => spec.startsWith(prefix)) ?? (/^(?:[./]|~\/)/u.test(spec) ? '' : undefined)
  if (protocol === undefined) return undefined
  const path = spec.slice(protocol.length).replace(/\/+$/u, '')
  const dir = /^(?:[/\\]|~[/\\]|[A-Za-z]:)/u.test(path) || path.includes('\\') ? '..' : join('.', path)
  if (dir === '..' || dir.startsWith('../')) throw new DeptreeError(`${quote(spec)} is not a directory under the lockfile's, which is not supported`, where)
  return { protocol, dir }
}

// The overrides pnpm installs with, in order, as its parseOverrides has
// them: each selector parsed, and its specifier with any catalog resolved,
// and `local` the directory it names, where it names one. By selector,
// they are what the lockfile's `overrides` is held to.
export function listOverrides(overrides, catalogs, major = 10) {
  const seen = new Set()
  return Object.entries(overrides ?? {}).map(([raw, given]) => {
    const where = `overrides[${quote(raw)}]`
    const selector = major >= 11 ? raw.trim() : raw
    if (seen.has(selector)) throw new DeptreeError(`${quote(selector)} is another selector's too, once pnpm 11 trims them`, where)
    seen.add(selector)
    const { parent, target } = parseSelector(selector, where)
    const spec = fromCatalog(catalogs, given, target.name, where, major)
    if (major < 11 || (target.range !== '' && parent?.range !== '')) return { selector, parent, target, spec, local: localOf(spec, where) }
    if (parent !== undefined) throw new DeptreeError('an empty range with a parent is refused by pnpm 11', where)
    if (valid(spec) === null) throw new DeptreeError(`${quote(spec)} is not the exact version pnpm 11 holds a converging override to`, where)
    return { selector, target, spec, converge: true }
  })
}

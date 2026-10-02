// Overrides as pnpm's parseOverrides reads them. A frozen install holds them
// only to the lockfile's `overrides`, which they were resolved with. pnpm 11
// reads `name@` and an exact version as converging: a dependency on `name`
// whose range takes that version is given it where no override is chosen.

import { valid } from '@preventive/upstream/semver.js'
import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

// From validate-npm-package-name 5, by which pnpm reads a selector's name.
const SCOPED = /^(?:@([^/]+?)\/)?([^/]+?)$/u
export function validForOldPackages(name) {
  if (name === '' || name.startsWith('.') || name.startsWith('_') || name.trim() !== name) return false
  if (name.toLowerCase() === 'node_modules' || name.toLowerCase() === 'favicon.ico') return false
  if (encodeURIComponent(name) === name) return true
  const m = SCOPED.exec(name)
  return m !== null && encodeURIComponent(m[1]) === m[1] && encodeURIComponent(m[2]) === m[2]
}

// @pnpm/parse-wanted-dependency.
function parseWanted(raw) {
  const at = raw.indexOf('@', 1)
  const name = at === -1 ? raw : raw.slice(0, at)
  return validForOldPackages(name) ? { name, range: at === -1 ? undefined : raw.slice(at + 1) } : undefined
}

// pnpm's DELIMITER_REGEX: `foo@>1` is one package, `bar@2>foo@1` two.
const DELIMITER = /[^ @|]>/u

export function parseSelector(selector, where) {
  if (!selector.isWellFormed()) throw new DeptreeError(`pnpm cannot parse the selector ${quote(selector)}`, where)
  const split = selector.search(DELIMITER)
  const parts = split === -1 ? [selector] : [selector.slice(0, split + 1), selector.slice(split + 2)]
  const parsed = parts.map(parseWanted)
  if (parsed.includes(undefined)) throw new DeptreeError(`pnpm cannot parse the selector ${quote(selector)}`, where)
  return parsed.length === 1 ? { target: parsed[0] } : { parent: parsed[0], target: parsed[1] }
}

// A layer's overrides with each `$name` replaced from the root package.json.
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

export const catalogOf = (spec) => (spec.startsWith(CATALOG) ? spec.slice(CATALOG.length).trim() || 'default' : undefined)

export const catalogEntry = (catalogs, catalog, name) => (Object.hasOwn(catalogs, catalog) && Object.hasOwn(catalogs[catalog], name) ? catalogs[catalog][name] : undefined)

// @pnpm/catalogs.resolver's resolveFromCatalog.
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

// As pnpm's local resolver reads a specifier.
export function localOf(spec, where) {
  const protocol = ['file:', 'link:'].find((prefix) => spec.startsWith(prefix)) ?? (/^(?:[./]|~\/)/u.test(spec) ? '' : undefined)
  if (protocol === undefined) return undefined
  const path = spec.slice(protocol.length).replace(/\/+$/u, '')
  const dir = /^(?:[/\\]|~[/\\]|[A-Za-z]:)/u.test(path) || path.includes('\\') ? '..' : join('.', path)
  if (dir === '..' || dir.startsWith('../')) throw new DeptreeError(`${quote(spec)} is not a directory under the lockfile's, which is not supported`, where)
  return { protocol, dir }
}

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

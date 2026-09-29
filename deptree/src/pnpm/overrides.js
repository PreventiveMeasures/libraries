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

// @pnpm/catalogs.resolver's resolveFromCatalog: the specifier a catalog
// gives `name`, where `spec` asks for one.
function fromCatalog(catalogs, spec, name, where) {
  if (!spec.startsWith(CATALOG)) return spec
  const catalog = spec.slice(CATALOG.length).trim() || 'default'
  const found = Object.hasOwn(catalogs, catalog) && Object.hasOwn(catalogs[catalog], name) ? catalogs[catalog][name] : undefined
  const refused = found === undefined ? `catalog ${quote(catalog)} has no entry for ${quote(name)}`
    : found.startsWith(CATALOG) ? `the entry for ${quote(name)} in catalog ${quote(catalog)} is itself a catalog reference`
    : ['workspace', 'link', 'file'].includes(found.split(':')[0]) ? `the entry for ${quote(name)} in catalog ${quote(catalog)} uses a protocol pnpm refuses in a catalog`
    : undefined
  if (refused !== undefined) throw new DeptreeError(`pnpm cannot resolve a catalog in the overrides: ${refused}`, where)
  return found
}

// The overrides pnpm installs with, in order, as its parseOverrides has
// them: each selector parsed, and its specifier with any catalog resolved.
export function listOverrides(overrides, catalogs) {
  return Object.entries(overrides ?? {}).map(([selector, spec]) => {
    const where = `overrides[${quote(selector)}]`
    const { parent, target } = parseSelector(selector, where)
    return { selector, parent, target, spec: fromCatalog(catalogs, spec, target.name, where) }
  })
}

// The same by selector, as createOverridesMapFromParsed has them for the
// lockfile's `overrides` to be held to.
export function parseOverrides(overrides, catalogs) {
  return Object.assign(Object.create(null), ...listOverrides(overrides, catalogs).map(({ selector, spec }) => ({ [selector]: spec })))
}

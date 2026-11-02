// babel-plugin-module-resolver, of a project's Babel config: where Babel
// runs it, and where the bundle maps its aliases as it resolves each import
// instead (babel-aliases.js), of a file loadFile() loads.

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { aliasing } from './babel-aliases.js'

export const RESOLVER = 'module-resolver'
// By module-resolver's options, the RegExps of a string its aliases match,
// as its normalizeAlias has each: a key that starts with `^` or ends with `$`
// a RegExp, each apart (its groups, of its backreferences, its own); the
// others the specifier each is and those under it, in one.
const ALIASES = new WeakMap()
// The calls of whose first argument module-resolver maps a string, as its
// normalizeOptions has them, but `require`'s, which esbuild resolves.
const CALLS = ['require.resolve', 'jest.genMockFromModule', 'jest.mock', 'jest.unmock', 'jest.doMock', 'jest.dontMock', 'jest.setMock', 'jest.requireActual', 'jest.requireMock', 'require.requireActual', 'require.requireMock', 'System.import']
// The plugins of a config, by key, that read no specifier of an import, a
// require or an export-from, or read it alike of an alias and of the
// relative path module-resolver maps it to (readsAlike()): Babel's, and
// those of @react-native/babel-preset (its own, of no name, by its path),
// Reanimated's but in bundle mode, and the inlining one rn adds.
const READS_NONE = new Set([
  ...['async-generator-functions', 'async-to-generator', 'arrow-functions', 'block-scoped-functions', 'block-scoping', 'class-properties', 'class-static-block', 'classes', 'computed-properties', 'destructuring', 'dotall-regex', 'duplicate-keys', 'dynamic-import', 'exponentiation-operator', 'explicit-resource-management', 'export-namespace-from', 'flow-enums', 'flow-strip-types', 'for-of', 'function-name', 'instanceof', 'json-strings', 'literals', 'logical-assignment-operators', 'member-expression-literals', 'modules-commonjs', 'named-capturing-groups-regex', 'new-target', 'nullish-coalescing-operator', 'numeric-separator', 'object-assign', 'object-rest-spread', 'object-super', 'optional-catch-binding', 'optional-chaining', 'parameters', 'private-methods', 'private-property-in-object', 'property-literals', 'react-display-name', 'react-jsx', 'react-jsx-development', 'react-jsx-self', 'react-jsx-source', 'regenerator', 'reserved-words', 'runtime', 'shorthand-properties', 'spread', 'sticky-regex', 'template-literals', 'typeof-symbol', 'typescript', 'unicode-escapes', 'unicode-property-regex', 'unicode-regex', 'unicode-sets-regex'].map((name) => `transform-${name}`),
  ...['class-properties', 'class-static-block', 'decorators', 'dynamic-import', 'export-default-from', 'export-namespace-from', 'flow', 'hermes-parser', 'jsx', 'nullish-coalescing-operator', 'numeric-separator', 'object-rest-spread', 'optional-catch-binding', 'optional-chaining', 'typescript'].map((name) => `syntax-${name}`),
  'proposal-export-default-from',
  RESOLVER,
  'inline-requires',
  'warn-on-deep-imports',
  'reanimated',
  'worklets',
])
const PRESET_OWN = /[\\/]@react-native[\\/]babel-preset[\\/.]/u

// Where module-resolver, of a file's config, of these options (`options`,
// undefined where the config has none), is had: 'babel', run by Babel;
// null, of nothing to do in the file; else { alias, cwd }, its aliases, as
// the bundle maps each import of the file as it resolves it (aliasing()),
// Babel without it, where it would map nothing else: of aliases alone, each
// to a relative path, in a file of no call but require's of those it maps
// a string of, and of no plugin that may read an import's specifier unlike
// of its alias and of where module-resolver maps it (READS_NONE). Of the
// file's `plugins`, by key; `contents`, the file's text, at `path`, of the
// project at `projectRoot`; `code`, Babel's input of it, where given: its
// calls as Babel has them, esbuild's of its types erased (`jest.mock!(`,
// `(jest as any).mock(`); where it is the file as it is, of types Babel
// erases itself, module-resolver kept.
export function resolverOf(options, contents, plugins, path, projectRoot, code = null) {
  const named = aliased(options, contents, plugins, helpersOf(projectRoot))
  if (named === null) return 'babel'
  if (named.length === 0) return null
  const of = mappedOf(options)
  const map = of === null ? null : aliasing(of)
  if (map === null || code === contents || [contents, code ?? ''].some((text) => callsOf(options).test(text) || BINDS_REQUIRE.test(text))) return 'babel'
  const reads = readers(plugins, path)
  if (reads === null) return 'babel'
  for (const specifier of named) {
    const mapped = map(path, specifier)
    if (mapped !== null && (!/^\.\.?\//u.test(mapped) || !reads.every((alike) => alike(specifier, mapped)))) return 'babel'
  }
  return of
}

// Of the options, { alias, cwd } of aliases alone, as the bundle maps them,
// as module-resolver has its cwd (of Babel's process: rn's), else null:
// one of each.
function mappedOf(options) {
  if (!MAPPED.has(options)) MAPPED.set(options, mappingOf(options))
  return MAPPED.get(options)
}
const MAPPED = new WeakMap()

function mappingOf(options) {
  const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!plain(options.alias) || !Object.values(options.alias).every((value) => typeof value === 'string')) return null
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd === 'babelrc' || options.cwd === 'packagejson')) return null
  if (options.transformFunctions !== undefined && (!Array.isArray(options.transformFunctions) || !options.transformFunctions.every((call) => typeof call === 'string'))) return null
  return { alias: options.alias, cwd: options.cwd || process.cwd() }
}

// A call of one of those of the options of CALLS, but require's, as the
// file's text may have it, as Babel's matchesPattern takes its callee: of
// its members by name, space or comments between its tokens, what it is a
// member of in parentheses too, before its arguments or TS's type
// arguments (`<`), which Babel's input has not; or of what each member is
// of, before a `[`, which may be of any string Babel takes for its name
// (`jest[('mock')]`). One RegExp of each.
function callsOf(options) {
  if (!CALLED.has(options)) {
    const escape = (name) => name.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')
    const closed = `${GAP}(?:\\)${GAP})*`
    const dotted = (names) => names.map((name, index) => (index === 0 ? escape(name) : `${closed}\\.${GAP}${escape(name)}`)).join('')
    const calls = CALLS.concat(options.transformFunctions ?? []).filter((call) => call !== 'require')
    const forms = calls.flatMap((call) => {
      const names = call.split('.')
      return [`${dotted(names)}${closed}[(<]`, ...names.slice(1).map((_, index) => `${dotted(names.slice(0, index + 1))}${closed}\\[`)]
    })
    CALLED.set(options, new RegExp(`(?<![\\w$.])(?:${forms.join('|')})`, 'u'))
  }
  return CALLED.get(options)
}
const CALLED = new WeakMap()
// Space or comments, as JS has them between two tokens.
const GAP = String.raw`(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*`
// `require` as the file may bind it, of a parameter, a declaration or an
// import, whose calls module-resolver maps a string of, as it maps
// require's, and esbuild resolves not: `require` but where it is called or
// a member is had of it, or where a function or class of its name is
// declared; in a comment or a string too.
const BINDS_REQUIRE = new RegExp(String.raw`(?<![\w$.])require(?![\w$]|${GAP}[(.])|\b(?:function|class)${GAP}\*?${GAP}require\b`, 'u')

// Of the file's plugins, by key, null where one may read a specifier unlike
// of its alias and of the relative path module-resolver maps it to; else
// those that read one, each (specifier, mapped) => whether it reads them
// alike, in the file at `path`.
function readers(plugins, path) {
  const reads = []
  for (const [key, given] of plugins) {
    if (PRESET_OWN.test(key)) continue
    if (!READS_NONE.has(key)) return null
    for (const options of given?.instances ?? [given ?? {}]) {
      // Of bundle mode, a relative import is taken for one of a package's.
      if ((key === 'reanimated' || key === 'worklets') && options?.bundleMode) return null
      // react-native's deep imports, warned of by their specifier.
      if (key === 'warn-on-deep-imports') reads.push((specifier) => !specifier.startsWith('react-native/'))
      // Metro's inlining, by the names it leaves, and @babel/runtime's, which it inlines not.
      if (key === 'inline-requires') {
        const names = new Set([...(options?.ignoredRequires ?? []), ...(options?.nonMemoizedModules ?? [])])
        const runtime = (name) => name.startsWith('@babel/runtime/')
        reads.push((specifier, mapped) => !names.has(specifier) && !names.has(mapped) && runtime(specifier) === runtime(mapped))
      }
      if (key === 'transform-modules-commonjs') reads.push((specifier, mapped) => lazyAlike(options?.lazy, specifier, mapped) && interopAlike(options?.importInterop, specifier, mapped, path))
    }
  }
  return reads
}

// As Babel's helper-module-transforms has `lazy` of a source.
function lazyAlike(lazy, specifier, mapped) {
  try {
    const of = (source) => (lazy === true ? !source.includes('.') : Array.isArray(lazy) ? lazy.includes(source) : typeof lazy === 'function' ? Boolean(lazy(source)) : false)
    return of(specifier) === of(mapped)
  } catch {
    return false
  }
}

// As Babel's helper-module-transforms asks it, of the source and the file.
function interopAlike(interop, specifier, mapped, path) {
  try {
    return typeof interop !== 'function' || interop(specifier, path) === interop(mapped, path)
  } catch {
    return false
  }
}

// The strings of the file module-resolver, of these options, may map: each
// string specifier is, in the file, a quote, its body and that quote again,
// on one line, or a template of no substitution, which
// transform-template-literals makes a string, so each such string of the
// file, from each quote or backtick not escaped (whatever the quotes before
// it), is tried, its escapes read as what they escape (a line continuation
// as nothing), a template's line breaks as `\n`. null where it may map more,
// as where it has `root` or a `resolvePath` of its own, in a file with an
// escape of a code point (`\x23`), or where an alias matches what Babel's
// plugins may write into a file (writesAliased()).
function aliased(options, contents, plugins, helpers) {
  if (options === undefined || options.instances !== undefined || options.resolvePath !== undefined || [options.root ?? []].flat().length > 0 || /\\[ux0-9]/u.test(contents)) return null
  const aliases = aliasesOf(options)
  if (aliases === null || writesAliased(options, aliases, plugins, contents, helpers)) return null
  const named = new Set()
  for (const { index, 0: quote } of contents.matchAll(/['"`]/gu)) {
    let backslashes = 0
    while (contents[index - 1 - backslashes] === '\\') backslashes++
    if (backslashes % 2 === 1) continue
    const body = BODIES[quote]
    body.lastIndex = index + 1
    const raw = body.exec(contents)?.[0]
    const value = raw?.slice(0, -1).replaceAll(/\\(\r\n|.)|\r\n?/gsu, (escape, of) => (of === undefined ? '\n' : (ESCAPED[of] ?? of)))
    if (value !== undefined && aliases.some((alias) => alias.test(value))) named.add(value)
  }
  return [...named]
}

// What a string's escape of one character is, but for those of what it
// escapes: a line continuation nothing.
const ESCAPED = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\n': '', '\r': '', '\r\n': '', '\u2028': '', '\u2029': '' }

// Of each quote, a string's body after it, and the quote that ends it: its
// escapes (a line continuation among them) its own, on one line; of a
// backtick, a template's, of no `${`, across lines, its escape a backslash
// and one character: an escaped CRLF is so of one way, not two, and a body
// of many, ending at a `${`, fails in linear time.
const BODIES = { "'": /(?:\\(?:\r\n|[^])|[^\\\n\r'])*'/uy, '"': /(?:\\(?:\r\n|[^])|[^\\\n\r"])*"/uy, '`': /(?:\\[^]|[^\\`$]|\$(?!\{))*`/uy }

// Whether an alias of module-resolver's matches what Babel's plugins of the
// config may write into a file that had none: the automatic JSX runtime's,
// of each importSource (the config's, and the file's @jsxImportSource), and
// transform-runtime's helpers, each of @babel/helpers' (`helpers`, null where
// not found), and regenerator, of its moduleName; with core-js or absolute
// paths, what it writes is no list: taken for one an alias matches. The
// config's, once.
function writesAliased(options, aliases, plugins, contents, helpers) {
  const each = (key) => {
    const of = plugins.get(key)
    return of === undefined ? [] : (of.instances ?? [of])
  }
  const sources = ['transform-react-jsx', 'transform-react-jsx-development'].flatMap(each).map(({ importSource = 'react' }) => importSource)
  const runtimes = each('transform-runtime')
  // Of core-js (its helpers of @babel/runtime-corejs3, and its polyfills) or
  // of absolute paths, what it writes isn't known.
  if (runtimes.some(({ corejs, absoluteRuntime }) => Boolean(corejs) || Boolean(absoluteRuntime))) return true
  const modules = runtimes.map(({ moduleName = '@babel/runtime' }) => moduleName)
  const jsxRuntimes = (source) => [`${source}/jsx-runtime`, `${source}/jsx-dev-runtime`]
  const matched = (specifiers) => specifiers.some((specifier) => aliases.some((alias) => alias.test(specifier)))
  const pragma = sources.length === 0 ? undefined : /@jsxImportSource\s+(\S+)/u.exec(contents)?.[1]
  if (pragma !== undefined && matched(jsxRuntimes(pragma))) return true
  const key = JSON.stringify([sources, modules])
  const known = WRITES.get(options) ?? new Map()
  WRITES.set(options, known)
  if (!known.has(key)) known.set(key, (modules.length > 0 && helpers === null) || matched([...sources.flatMap(jsxRuntimes), ...modules.flatMap((module) => [`${module}/regenerator`, ...helpers.flatMap((name) => [`${module}/helpers/${name}`, `${module}/helpers/esm/${name}`])])]))
  return known.get(key)
}
const WRITES = new WeakMap()

// By project root, the names of Babel's helpers, as its @babel/core has them.
const HELPERS = new Map()
function helpersOf(projectRoot) {
  if (!HELPERS.has(projectRoot)) {
    try {
      HELPERS.set(projectRoot, createRequire(createRequire(join(projectRoot, 'package.json')).resolve('@babel/core'))('@babel/helpers').list ?? null)
    } catch {
      HELPERS.set(projectRoot, null)
    }
  }
  return HELPERS.get(projectRoot)
}

// -> ALIASES' RegExps of the options, null where one of its aliases is no RegExp.
function aliasesOf(options) {
  if (!ALIASES.has(options)) {
    const keys = [options.alias ?? {}].flat().flatMap((alias) => Object.keys(alias))
    const escape = (key) => key.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const patterns = keys.filter((key) => key.startsWith('^') || key.endsWith('$'))
    const specifiers = keys.filter((key) => !patterns.includes(key))
    try {
      // eslint-disable-next-line require-unicode-regexp -- as module-resolver compiles a key: no flags
      const compiled = patterns.map((key) => new RegExp(key))
      ALIASES.set(options, specifiers.length === 0 ? compiled : [...compiled, new RegExp(`^(?:${specifiers.map(escape).join('|')})(?:/|$)`, 'su')])
    } catch {
      ALIASES.set(options, null)
    }
  }
  return ALIASES.get(options)
}


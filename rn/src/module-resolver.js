// babel-plugin-module-resolver in a project's Babel config: per file, whether Babel runs it or the
// bundle maps its aliases as it resolves imports (babel-aliases.js), for a file loadFile() loads.

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { aliasing } from './babel-aliases.js'

export const RESOLVER = 'module-resolver'
// Calls whose first string argument module-resolver maps (its normalizeOptions), less `require`,
// which esbuild resolves.
const CALLS = ['require.resolve', 'jest.genMockFromModule', 'jest.mock', 'jest.unmock', 'jest.doMock', 'jest.dontMock', 'jest.setMock', 'jest.requireActual', 'jest.requireMock', 'require.requireActual', 'require.requireMock', 'System.import']
// Plugins, by key, that read no import, require or export-from specifier, or read an alias and its
// mapped relative path alike (readers()): Babel's, @react-native/babel-preset's, Reanimated's
// outside bundle mode, and rn's inlining.
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
// @react-native/babel-preset's own plugins, which have no name and are keyed by path.
const PRESET_OWN = /[\\/]@react-native[\\/]babel-preset[\\/.]/u
// Whitespace or comments between two JS tokens.
const GAP = String.raw`(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*`
// `require` other than called or accessed, or declared as a function or class (in comments and
// strings too): the file may bind its own, whose calls module-resolver maps but esbuild won't resolve.
const BINDS_REQUIRE = new RegExp(String.raw`(?<![\w$.])require(?![\w$]|${GAP}[(.])|\b(?:function|class)${GAP}\*?${GAP}require\b`, 'u')
// Single-character string escapes; a line continuation is nothing.
const ESCAPED = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\n': '', '\r': '', '\r\n': '', '\u2028': '', '\u2029': '' }
// A string's body after its opening quote, through the closing one: on one line for quotes, or a
// template without `${` for a backtick. An escape is a backslash and one character (CRLF counts
// as one), so a failing match takes linear time.
const BODIES = { "'": /(?:\\(?:\r\n|[^])|[^\\\n\r'])*'/uy, '"': /(?:\\(?:\r\n|[^])|[^\\\n\r"])*"/uy, '`': /(?:\\[^]|[^\\`$]|\$(?!\{))*`/uy }

// prepare() by options object; Babel's helpers by project root.
const PREPARED = new WeakMap()
const HELPERS = new Map()

const memo = (cache, key, make) => {
  if (!cache.has(key)) cache.set(key, make())
  return cache.get(key)
}

// How module-resolver (`options`, undefined if not configured) applies to the file at `path`:
// 'babel' to keep it in Babel, null if it maps nothing there, or { alias, cwd } for the bundle to
// apply instead, where that is provably the same. `code` is Babel's input, if given.
export function resolverOf(options, contents, plugins, path, projectRoot, code = null) {
  if (options === undefined) return 'babel'
  const { aliased, mapped, calls, writes } = memo(PREPARED, options, () => prepare(options))
  // A code point escape (`\x23`) may spell an alias.
  if (aliased === null || /\\[ux0-9]/u.test(contents) || writesAliased(writes, aliased, plugins, contents, projectRoot)) return 'babel'
  const named = stringsIn(contents).filter(aliased)
  if (named.length === 0) return null
  // A call is seen only with types erased (by esbuild): `jest.mock!(`, `(jest as any).mock(`.
  if (mapped === null || code === contents || [contents, code ?? ''].some((text) => calls.test(text) || BINDS_REQUIRE.test(text))) return 'babel'
  const reads = readers(plugins, path)
  if (reads === null) return 'babel'
  const map = aliasing(mapped)
  for (const specifier of named) {
    const to = map(path, specifier)
    if (to !== null && (!/^\.\.?\//u.test(to) || !reads.every((alike) => alike(specifier, to)))) return 'babel'
  }
  return mapped
}

// What resolverOf() reads of the options.
function prepare(options) {
  const { alias, cwd, transformFunctions } = options
  // Aliases alone, as the bundle maps them.
  const mappable = alias !== null && typeof alias === 'object' && !Array.isArray(alias) && Object.values(alias).every((value) => typeof value === 'string')
    && (cwd === undefined || (typeof cwd === 'string' && cwd !== 'babelrc' && cwd !== 'packagejson'))
    && (transformFunctions === undefined || (Array.isArray(transformFunctions) && transformFunctions.every((call) => typeof call === 'string')))
  return {
    // Null where module-resolver may map more than its aliases.
    aliased: options.instances !== undefined || options.resolvePath !== undefined || [options.root ?? []].flat().length > 0 ? null : aliasesOf(alias),
    // The cwd defaults to the process's, as module-resolver's does (Babel runs in rn's process).
    mapped: mappable ? { alias, cwd: cwd || process.cwd() } : null,
    calls: mappable ? callsOf(transformFunctions ?? []) : null,
    // writesAliased()'s answers.
    writes: new Map(),
  }
}

// (string) => whether an alias matches it, as module-resolver's normalizeAlias has them: a key starting
// `^` or ending `$` is a RegExp of its own; the others match themselves and what is under them.
// Null if a key is no valid RegExp.
function aliasesOf(alias) {
  const keys = [alias ?? {}].flat().flatMap((each) => Object.keys(each))
  const patterns = keys.filter((key) => key.startsWith('^') || key.endsWith('$'))
  const names = keys.filter((key) => !patterns.includes(key))
  try {
    // eslint-disable-next-line require-unicode-regexp -- module-resolver compiles a key with no flags
    const regExps = patterns.map((key) => new RegExp(key))
    if (names.length > 0) regExps.push(new RegExp(`^(?:${names.map(RegExp.escape).join('|')})(?:/|$)`, 'su'))
    return (value) => regExps.some((regExp) => regExp.test(value))
  } catch {
    return null
  }
}

// A call of CALLS or transformFunctions (less require) in the file's text, as Babel's
// matchesPattern takes the callee: gaps and parentheses between tokens, then `(` or type
// arguments; or a member followed by `[`, which may name anything (`jest[('mock')]`).
function callsOf(transformFunctions) {
  const closed = String.raw`${GAP}(?:\)${GAP})*`
  const dotted = (names) => names.map((name, index) => (index === 0 ? RegExp.escape(name) : String.raw`${closed}\.${GAP}${RegExp.escape(name)}`)).join('')
  const forms = [...CALLS, ...transformFunctions].filter((call) => call !== 'require').flatMap((call) => {
    const names = call.split('.')
    return [`${dotted(names)}${closed}[(<]`, ...names.slice(1).map((_, index) => String.raw`${dotted(names.slice(0, index + 1))}${closed}\[`)]
  })
  return new RegExp(String.raw`(?<![\w$.])(?:${forms.join('|')})`, 'u')
}

// The file's strings: one from each unescaped quote, or a template (transform-template-literals
// makes it one), its escapes decoded and a template's line breaks read as `\n`.
function stringsIn(contents) {
  const strings = new Set()
  for (const { index, 0: quote } of contents.matchAll(/['"`]/gu)) {
    let backslashes = 0
    while (contents[index - 1 - backslashes] === '\\') backslashes++
    if (backslashes % 2 === 1) continue
    const body = BODIES[quote]
    body.lastIndex = index + 1
    const value = body.exec(contents)?.[0].slice(0, -1).replaceAll(/\\(\r\n|.)|\r\n?/gsu, (_, escaped) => (escaped === undefined ? '\n' : (ESCAPED[escaped] ?? escaped)))
    if (value !== undefined) strings.add(value)
  }
  return [...strings]
}

// Each instance's options of the file's plugin `key`.
function instances(plugins, key) {
  const given = plugins.get(key)
  return given === undefined ? [] : (given.instances ?? [given])
}

// Whether `of` gives the same for both; false if it throws.
function sameFor(of, specifier, mapped) {
  try {
    return of(specifier) === of(mapped)
  } catch {
    return false
  }
}

// Checks (specifier, mapped) => whether the file's plugins (by key) treat both alike; null if
// some plugin may not.
function readers(plugins, path) {
  const reads = []
  for (const key of plugins.keys()) {
    if (PRESET_OWN.test(key)) continue
    if (!READS_NONE.has(key)) return null
    for (const options of instances(plugins, key)) {
      // In bundle mode, it treats a relative import as a package's.
      if ((key === 'reanimated' || key === 'worklets') && options.bundleMode) return null
      // Its warning on react-native deep imports reads the specifier.
      if (key === 'warn-on-deep-imports') reads.push((specifier) => !specifier.startsWith('react-native/'))
      // Metro's inlining skips the names it's given, and @babel/runtime's.
      if (key === 'inline-requires') {
        const names = new Set([...(options.ignoredRequires ?? []), ...(options.nonMemoizedModules ?? [])])
        reads.push((specifier, mapped) => !names.has(specifier) && !names.has(mapped) && sameFor((name) => name.startsWith('@babel/runtime/'), specifier, mapped))
      }
      // `lazy` and `importInterop` of a source, as Babel's helper-module-transforms reads them.
      if (key === 'transform-modules-commonjs') {
        const { lazy, importInterop } = options
        const isLazy = (source) => (lazy === true ? !source.includes('.') : Array.isArray(lazy) ? lazy.includes(source) : typeof lazy === 'function' && Boolean(lazy(source)))
        reads.push((specifier, mapped) => sameFor(isLazy, specifier, mapped) && (typeof importInterop !== 'function' || sameFor((source) => importInterop(source, path), specifier, mapped)))
      }
    }
  }
  return reads
}

// Whether an alias matches what Babel's plugins may write into a file that had none: the
// automatic JSX runtime of each importSource (and the file's @jsxImportSource), transform-runtime's
// helpers and regenerator. True when that is unknown: with core-js, absoluteRuntime or no helper list.
function writesAliased(writes, aliased, plugins, contents, projectRoot) {
  const sources = ['transform-react-jsx', 'transform-react-jsx-development'].flatMap((key) => instances(plugins, key)).map(({ importSource = 'react' }) => importSource)
  const runtimes = instances(plugins, 'transform-runtime')
  if (runtimes.some(({ corejs, absoluteRuntime }) => corejs || absoluteRuntime)) return true
  const modules = runtimes.map(({ moduleName = '@babel/runtime' }) => moduleName)
  const jsxRuntimes = (source) => [`${source}/jsx-runtime`, `${source}/jsx-dev-runtime`]
  const pragma = /@jsxImportSource\s+(\S+)/u.exec(contents)?.[1]
  if (sources.length > 0 && pragma !== undefined && jsxRuntimes(pragma).some(aliased)) return true
  return memo(writes, JSON.stringify([sources, modules]), () => {
    const helpers = modules.length === 0 ? [] : helpersOf(projectRoot)
    return helpers === null || [...sources.flatMap(jsxRuntimes), ...modules.flatMap((module) => [`${module}/regenerator`, ...helpers.flatMap((name) => [`${module}/helpers/${name}`, `${module}/helpers/esm/${name}`])])].some(aliased)
  })
}

// The names of Babel's helpers, as the project's @babel/core has them; null if not found.
function helpersOf(projectRoot) {
  return memo(HELPERS, projectRoot, () => {
    try {
      return createRequire(createRequire(join(projectRoot, 'package.json')).resolve('@babel/core'))('@babel/helpers').list ?? null
    } catch {
      return null
    }
  })
}

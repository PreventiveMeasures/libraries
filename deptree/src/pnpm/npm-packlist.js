// The walks of npm-packlist over ignore-walk that pnpm 9 and 10 (npm-packlist
// 5.1.3, ignore-walk 5) and pnpm 11 (npm-packlist 10.0.4, ignore-walk 8)
// run over a directory, kept to their steps, odd ones and all: a walker of a
// directory asks its parent of each entry by a path from there, and reads
// the ignore files among its entries, in the order ignoreFiles lists them.
// `view` reads the directory, and refuses what is not followed here.

import { basename, dirname, join, normalize } from '@preventive/vfs/path.js'
import { quote } from '../error.js'
import { glob } from './glob.js'
import { caseless, fromParts, rulesOf } from './minimatch.js'

const DEFAULTS = ['.npmignore', '.gitignore', '**/.git', '**/.svn', '**/.hg', '**/CVS', '**/.git/**', '**/.svn/**', '**/.hg/**', '**/CVS/**', '/.lock-wscript', '/.wafpickle-*', '/build/config.gypi', 'npm-debug.log', '**/.npmrc', '.*.swp', '.DS_Store', '**/.DS_Store/**', '._*', '**/._*/**', '*.orig']

const BUILTIN = Symbol('built-in rules')
const NECESSARY = Symbol('necessary rules')
const STRICT = Symbol('strict rules')

const MUST_HAVE_NAMES = ['readme', 'copying', 'license', 'licence']
const MUST_HAVE_RE = caseless(String.raw`^(?:readme|copying|license|licence)(?:\..*[^~$])?$`)
const NO_TRAVERSAL_5 = String.raw`(?!(?:^|\/)\.{1,2}(?:$|\/))`

// npm-packlist 5's `@(readme|copying|license|licence){,.*[^~$]}`, as glob
// and minimatch 5 read it: two patterns of one part.
const MUST_HAVES_5 = ['', String.raw`\.[^/]*?[^~$]`].map((rest) => [caseless(`^${NO_TRAVERSAL_5}(?=.)(?:${MUST_HAVE_NAMES.join('|')})${rest}$`)])

// npm-packlist 10's `!/readme{,.*[^~$]}` and the like, as minimatch 10 reads them.
const MUST_HAVES_10 = MUST_HAVE_NAMES.map((name) => fromParts(true, ['', String.raw`\.[^/]*?[^~$]`].map((rest) => ['', caseless(`^${name}${rest}$`)]), '10.2'))

const relOf = (walker, entry) => (walker.rel === '' ? entry : `${walker.rel}/${entry}`)

export function readRules(view, rel, minimatch, where) {
  const here = `${where}: ${quote(rel)}`
  return rulesOf([view.text(rel, here)], minimatch, here)
}

// What ignore-walk 5 and 8 make of one rule against an entry.
function ruleMatches(rule, entry, partial, base) {
  const relative = base !== undefined && rule.globParts.some((part) => part.length <= (part.at(-1) ? 1 : 2))
  return rule.test(`/${entry}`) || rule.test(entry) || (partial && (
    rule.test(`/${entry}/`) || rule.test(`${entry}/`) || (rule.negate && (rule.test(`/${entry}`, true) || rule.test(entry, true)))
    || (relative && (rule.test(`/${base}/`) || rule.test(`${base}/`) || (rule.negate && (rule.test(`/${base}`, true) || rule.test(base, true)))))))
}

function applyRules(walker, entry, partial, included, base) {
  let kept = included
  for (const file of walker.ignoreFiles) {
    for (const rule of walker.rules.get(file) ?? []) {
      if (rule.negate !== kept && ruleMatches(rule, entry, partial, base)) kept = rule.negate
    }
  }
  return kept
}

// npm-packlist 5's pathHasPkg: a package's directory in node_modules.
function packageIn(entry) {
  if (!entry.startsWith('node_modules/')) return false
  const [first, ...rest] = entry.slice('node_modules/'.length).split('/', 2)
  return first !== '' && (!first.startsWith('@') || rest.length === 1)
}

// npm-packlist 5's filterEntry over ignore-walk 5's.
function filter5(walker, entry, partial) {
  const { isProject } = walker
  if (!isProject && /^node_modules(?:$|\/)/iu.test(walker.rel)) return filter5(walker.parent, `${walker.basename}/${entry}`, partial)
  if (isProject && (entry === 'node_modules' || packageIn(entry))) return false
  if ((isProject && entry === 'package.json') || MUST_HAVE_RE.test(entry) || (isProject && entry === 'npm-shrinkwrap.json')) return true
  if (isProject && entry === 'package-lock.json') return false
  const included = isProject ? true : filter5(walker.parent, `${walker.basename}/${entry}`, partial)
  return applyRules(walker, entry, partial, included)
}

// ignore-walk 8's filterEntry, which npm-packlist 10 keeps.
function filter10(walker, entry, partial, base) {
  let included = true
  if (walker.parent !== undefined) {
    included = filter10(walker.parent, `${walker.basename}/${entry}`, partial, base ?? entry)
    if (!included && !walker.exact) return false
  }
  return applyRules(walker, entry, partial, included, base)
}

// A walk of one directory: its ignore files read, its entries filtered,
// then each file kept and each directory walked. `entries` are its own, or,
// for npm-packlist 5's root where package.json has `files`, what those take.
function visit(view, walker, entries, engine, result) {
  if (entries.length === 0) return
  for (const entry of entries) {
    if (walker.ignoreFiles.includes(entry)) engine.readIgnore(walker, entry)
  }
  if (engine.major >= 11 && walker.rules.has('package.json')) walker.rules.delete('.npmignore')
  if (walker.rules.has('.npmignore') || (engine.major >= 11 && walker.rules.has('package.json'))) walker.rules.delete('.gitignore')
  for (const entry of entries) {
    const file = engine.filter(walker, entry, false)
    const dir = engine.filter(walker, entry, true)
    if ((!file && !dir) || entry.includes('*')) continue
    const rel = relOf(walker, entry)
    if (view.type(rel) !== 'directory') {
      if (file) result.add(rel)
    } else if (dir) visit(view, engine.child(walker, entry, rel, file), view.entries(rel), engine, result)
  }
}

// npm-normalize-package-bin 2's bin: an object, or nothing.
function normalizeBin(pkg) {
  const { bin } = pkg
  const named = typeof bin === 'string' ? (pkg.name ? { [pkg.name]: bin } : {})
    : Array.isArray(bin) ? Object.fromEntries(bin.map((path) => [basename(String(path)), path]))
      : bin !== null && typeof bin === 'object' ? bin : {}
  const clean = Object.entries(named).map(([key, path]) => [
    join('/', basename(key.replaceAll(/[:\\]/gu, '/'))).slice(1),
    typeof path === 'string' ? join('/', path).replaceAll('\\', '/').slice(1) : '',
  ]).filter(([key, path]) => key !== '' && path !== '')
  return clean.length > 0 ? Object.fromEntries(clean) : undefined
}

// npm-packlist 5's mustHaveFilesFromPackage, of `pkg` with its bin normalized.
const mustHaves5 = (pkg) => [
  ...[pkg.browser, pkg.main, ...Object.values(pkg.bin ?? {})].filter(Boolean).map((path) => `/${path}`),
  '/package.json', '/npm-shrinkwrap.json', '!/package-lock.json', MUST_HAVES_5,
]

// npm-packlist 5's root entries where package.json has `files`: what glob
// takes of each pattern in turn, a `!` one's taken back out.
function filesEntries5(view, pkg, where) {
  const taken = new Set()
  const negates = new Set()
  for (const pattern of new Set([...pkg.files, ...mustHaves5(pkg)])) {
    const negate = typeof pattern === 'string' && pattern.match(/^!*/u)[0].length % 2 === 1
    const body = typeof pattern === 'string' ? pattern.replace(/^!+/u, '').replace(/^\.?\/+/u, '') : pattern
    for (const found of glob(view, body, where)) {
      const path = found.replace(/\/+$/u, '')
      ;(negate ? taken : negates).delete(path)
      ;(negate ? negates : taken).add(path)
    }
  }
  pkg.files = [...taken, ...[...negates].map((path) => `!${path}`)]
  return [...new Set([...taken].map((path) => path.replace(/^\/+/u, '')))]
}

// `manifest` is undefined where npm-packlist fails to parse package.json,
// which it then reads no rules of. `minimatch` is the version pnpm bundles.
export function pack10(view, manifest, where, minimatch) {
  const pkg = manifest === undefined ? undefined : { ...structuredClone(manifest), bin: normalizeBin(manifest) }
  const files = Array.isArray(pkg?.files)
  const rules = new Map([[BUILTIN, rulesOf([...DEFAULTS, '/package-lock.json', '/yarn.lock', '/pnpm-lock.yaml', '/archived-packages/**'], minimatch, where)]])
  const root = { rel: '', isProject: true, rules, ignoreFiles: [BUILTIN, 'package.json', '.npmignore', '.gitignore', NECESSARY] }
  const own = view.entries('').filter((entry) => entry !== '.git' && entry !== 'node_modules')
  const engine = {
    major: 10,
    filter: filter5,
    readIgnore(walker, entry) {
      if (entry !== 'package.json') walker.rules.set(entry, readRules(view, relOf(walker, entry), minimatch, where))
      else if (walker.isProject && files) walker.rules.set(entry, rulesOf(pkg.files.map((path) => `!${path}`), minimatch, where))
      else if (walker.isProject && pkg !== undefined) walker.rules.set(NECESSARY, rulesOf(mustHaves5(pkg).map((path) => (Array.isArray(path) ? fromParts(true, path, minimatch) : `!${path}`)), minimatch, where))
    },
    child: (walker, entry, rel) => ({ rel, parent: walker, basename: basename(rel), isProject: false, rules: new Map(), ignoreFiles: walker.ignoreFiles }),
  }
  const result = new Set()
  visit(view, root, files && own.includes('package.json') ? filesEntries5(view, pkg, where) : own, engine, result)
  return result
}

// npm-packlist 10's processPackage: package.json's rules, and the strict ones.
// pnpm from 11.28 keeps a package.yaml and a package.json5 too, by `alternates`.
function processPackage(view, walker, pkg, where, alternates) {
  const ignores = []
  const strict = ['/.git', '!/package.json', ...MUST_HAVES_10, '/.git', '/node_modules', '.npmrc', '/package-lock.json', '/yarn.lock', '/pnpm-lock.yaml', '/bun.lockb']
  for (const entry of pkg.files ?? []) {
    let file = entry.startsWith('./') ? entry.slice(1) : entry
    if (file.endsWith('/*')) file += '*'
    const type = view.type(file.replace(/^!+/u, ''))
    if (type === 'file') {
      strict.unshift(`!${file}`)
      walker.requiredFiles.push(file.startsWith('/') ? file.slice(1) : file)
    } else if (type === 'directory') ignores.push(`!${file}`, `!${file}/**`)
    else ignores.push(`!${file}`)
  }
  if (pkg.files) walker.rules.set('package.json', rulesOf(['*', ...ignores], '10.2', where))
  const fields = [pkg.browser, pkg.main, ...pkg.bin === undefined || pkg.bin === null ? [] : Object.values(pkg.bin)].filter(Boolean).map((path) => `!/${path}`)
  walker.rules.set(STRICT, rulesOf([...strict, ...fields, ...alternates ? ['!/package.yaml', '!/package.json5'] : []], '10.2', where))
}

// pnpm's normalizePackage: `./` taken off main, browser and each bin.
const stripDotSlash = (path) => (typeof path === 'string' ? path.replace(/^\.[/\\]/u, '') : path)

export function pack11(view, manifest, where, alternates) {
  const { bin } = manifest
  const pkg = {
    ...manifest,
    main: stripDotSlash(manifest.main),
    browser: stripDotSlash(manifest.browser),
    bin: bin !== null && typeof bin === 'object' ? Object.fromEntries(Object.entries(bin).map(([key, path]) => [key, stripDotSlash(path)])) : stripDotSlash(bin),
  }
  const defaults = rulesOf([...DEFAULTS, '/archived-packages/**'], '10.2', where)
  const walkerOf = (fields) => {
    const made = { rules: new Map([[BUILTIN, defaults]]), requiredFiles: [], ...fields }
    if (!made.isPackage) made.rules.set(STRICT, rulesOf(['/.git', ...made.requiredFiles.map((file) => `!${file}`)], '10.2', where))
    return made
  }
  const root = walkerOf({ rel: '', isPackage: true, ignoreFiles: [BUILTIN, 'package.json', '.npmignore', '.gitignore', STRICT] })
  const engine = {
    major: 11,
    filter: filter10,
    readIgnore(walker, entry) {
      if (entry === 'package.json' && walker.isPackage) processPackage(view, walker, pkg, where, alternates)
      else walker.rules.set(entry, readRules(view, relOf(walker, entry), '10.2', where))
    },
    child: (parent, entry, rel, file) => walkerOf({
      rel,
      parent,
      basename: entry,
      exact: file || filter10(parent, `${entry}/`, false),
      ignoreFiles: [BUILTIN, '.npmignore', '.gitignore', STRICT],
      requiredFiles: parent.requiredFiles.map(normalize).filter((path) => dirname(path) === entry).map((path) => basename(path)),
    }),
  }
  const result = new Set()
  visit(view, root, view.entries(''), engine, result)
  return result
}

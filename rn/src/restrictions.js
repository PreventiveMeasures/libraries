// rn.config.json's allowedPaths, disallowedPaths, allowedModules and disallowedModules: globs of the files
// a build may take, each rule checked on its own. Paths are real paths from the project root, modules the
// names of the packages files are of (packagesOf()).

import { dirname, isAbsolute, join, relative } from 'node:path'

const RN_CONFIG = 'rn.config.json'

// A glob less a leading `./` and a trailing `/`.
const trimmed = (glob) => glob.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')

// Whether each brace is of a balanced `{...}` holding a `,` of its own, none after a `$`: the lists Node's glob
// expands, where it takes `{a}` and `${a,b}` as themselves, `{1..3}` for a range and expands `{{a,b}}` within.
function bracesListed(glob) {
  const listed = []
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '{') {
      if (glob[i - 1] === '$') return false
      listed.push(false)
    } else if (glob[i] === ',' && listed.length > 0) {
      listed[listed.length - 1] = true
    } else if (glob[i] === '}' && listed.pop() !== true) {
      return false
    }
  }
  return listed.length === 0
}

// Whether `glob` holds an extglob (`@(a|b)`), or may once its braces expand, as Node's glob expands them first
// (`{@,x}(a)` is `@(a)` or `x(a)`): an operator and a `(` each touching a brace, taken as forming one.
const extglob = (glob) => /[!*+?@]\(/u.test(glob) || (/[!*+?@][,{}]/u.test(glob) && /[,{}]\(/u.test(glob))

// Whether each `**` is a whole name: Node's glob takes `a**` for `a*`, where this would cross a `/`.
const globstarsWhole = (glob) => [...glob.matchAll(/\*{2,}/gu)].every(({ 0: stars, index }) =>
  stars.length === 2 && (index === 0 || glob[index - 1] === '/') && (index + 2 === glob.length || glob[index + 2] === '/'))

// A path glob as a RegExp, or null where Node's glob would read it otherwise: an extglob (`@(a|b)`), a brace of no
// list, a `**` within a name. `[...]` is itself (app/[id].js); `**` matches dot files too (Node's misses pnpm's
// .pnpm). With `within`, a glob also matches what is inside a directory it matches (`secrets` all of secrets/).
export function globRegExp(glob, within = false) {
  const bare = trimmed(glob)
  if (extglob(bare) || !bracesListed(bare) || !globstarsWhole(bare)) return null
  let depth = 0
  const token = (part) => {
    if (part === '**/') return '(?:.*/)?'
    if (part === '**') return '.*'
    if (part === '*') return '[^/]*'
    if (part === '?') return '[^/]'
    if (part === ',') return depth > 0 ? '|' : ','
    if (part === '{') {
      depth++
      return '(?:'
    }
    if (part === '}') {
      depth--
      return ')'
    }
    return RegExp.escape(part)
  }
  const source = bare.replaceAll(/\*\*\/|\*\*|[*?{},]|[^*?{},]+/gu, token)
  // `s`: a name may hold a line break, which `.*` (`**`, a directory's paths) must match too.
  return new RegExp(within ? `^(?:${source})(?:/.*)?$` : `^${source}$`, 'su')
}

// Whether a glob of paths is one a path from the project root may match: relative, of `/`s, and with no `.`,
// `..` (but leading ones, out of the project) or empty name, which no such path has.
export function isPathGlob(glob) {
  if (glob === '' || isAbsolute(glob) || glob.includes('\\') || globRegExp(glob) === null) return false
  const names = trimmed(glob).split('/')
  const inside = names.slice(names.findLastIndex((name) => name === '..') + 1)
  return names.slice(0, names.length - inside.length).every((name) => name === '..') && inside.every((name) => name !== '' && name !== '.' && name !== '..')
}

// The package a file at `path` is installed in by its innermost node_modules directory, { dir, name }: its
// directory, and the name it is installed under; null where it is in none.
export function installedOf(path) {
  const parts = path.split(/[/\\]/u)
  const at = parts.lastIndexOf('node_modules') + 1
  if (at === 0 || at === parts.length) return null
  const end = parts[at].startsWith('@') && at + 1 < parts.length - 1 ? at + 2 : at + 1
  return { dir: parts.slice(0, end).join('/'), name: parts.slice(at, end).join('/') }
}

// -> (path) => a file's package name: an installed package's package.json name (an npm alias installs it
// under another), else the name it is installed under; outside node_modules, the nearest package.json's
// name; null where none has one. Reads through `host`, so a watcher sees each package.json.
export function packagesOf(host) {
  const named = new Map()
  const nameIn = (dir) => {
    if (!named.has(dir)) named.set(dir, manifestName(host, join(dir, 'package.json')) ?? (dirname(dir) === dir ? null : nameIn(dirname(dir))))
    return named.get(dir)
  }
  const installs = new Map()
  return (path) => {
    const installed = installedOf(path)
    if (installed === null) return nameIn(dirname(path))
    if (!installs.has(installed.dir)) installs.set(installed.dir, manifestName(host, join(installed.dir, 'package.json')) ?? installed.name)
    return installs.get(installed.dir)
  }
}

function manifestName(host, path) {
  if (!host.isFile(path)) return null
  try {
    const { name } = JSON.parse(String(host.readFile(path)))
    return typeof name === 'string' && name !== '' ? name : null
  } catch {
    return null
  }
}

// -> (path, module) => the errors of the rules the file breaks, or null where the config sets none. The
// build's section (development or production) adds its rules to the top level's.
export function restrictionsOf(config, projectRoot, dev) {
  const mode = dev ? 'development' : 'production'
  const rules = [...rulesOf(config, ''), ...rulesOf(config[mode] ?? {}, `${mode}.`)]
  if (rules.length === 0) return null
  return (path, module) => {
    const name = relative(projectRoot, path).replaceAll('\\', '/')
    return rules.map((rule) => rule(name, module)).filter((error) => error !== null)
  }
}

// Each rule `options` sets, as (name, module) => its error or null. Module rules check a package by both its
// package.json name and the name it is installed under, as these can differ (aliases, git or tarball
// dependencies): either name forbidden forbids it, and only both allowed allows it.
function rulesOf(options, prefix) {
  const globs = (key) => options[key].map((glob) => ({ glob, test: globRegExp(glob, key.endsWith('Paths')) }))
  const matching = (list, value) => list.find(({ test }) => test.test(value))
  const named = (key) => `${RN_CONFIG}'s ${prefix}${key}`
  // `module`, and the name it is installed under where that differs, each with its error wording.
  const namesOf = (name, module) => {
    const installed = installedOf(name)?.name
    const of = { value: module, text: `is of ${module}` }
    return installed === undefined || installed === module ? [of] : [of, { value: installed, text: `is installed as ${installed} (of ${module})` }]
  }
  const rules = []
  if (options.allowedPaths !== undefined) {
    const allowed = globs('allowedPaths')
    rules.push((name) => (matching(allowed, name) ? null : `${name} matches none of ${named('allowedPaths')}`))
  }
  if (options.disallowedPaths !== undefined) {
    const disallowed = globs('disallowedPaths')
    rules.push((name) => {
      const found = matching(disallowed, name)
      return found === undefined ? null : `${name} matches ${JSON.stringify(found.glob)} of ${named('disallowedPaths')}`
    })
  }
  if (options.allowedModules !== undefined) {
    const allowed = globs('allowedModules')
    rules.push((name, module) => {
      if (module === null) return `${name} is of no package (no package.json above it has a name), which ${named('allowedModules')} allows none of`
      const unmatched = namesOf(name, module).find(({ value }) => matching(allowed, value) === undefined)
      return unmatched === undefined ? null : `${name} ${unmatched.text}, which matches none of ${named('allowedModules')}`
    })
  }
  if (options.disallowedModules !== undefined) {
    const disallowed = globs('disallowedModules')
    rules.push((name, module) => {
      if (module === null) return null
      for (const { value, text } of namesOf(name, module)) {
        const found = matching(disallowed, value)
        if (found !== undefined) return `${name} ${text}, which matches ${JSON.stringify(found.glob)} of ${named('disallowedModules')}`
      }
      return null
    })
  }
  return rules
}

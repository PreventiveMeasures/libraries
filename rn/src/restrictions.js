// rn.config.json's allowedPaths, disallowedPaths, allowedModules and disallowedModules: the files a build may
// take, each rule checked on its own, a file breaking any of them an error. A path is a file's real path from
// the project root, a module the name of the package it is of (packagesOf()), each as globs match it
// (globRegExp()): a path glob each file in a directory it matches too. With allowedModules, a file of no
// package is of none it allows. Those of development or production add to the top level's (restrictionsOf()).

import { dirname, isAbsolute, join, relative } from 'node:path'

const RN_CONFIG = 'rn.config.json'

// A glob of a path from the project root as a RegExp, or null where its braces don't pair: `**` any path, dot
// files' too (unlike Node's path.matchesGlob, which pnpm's node_modules/.pnpm would fail), `*` any characters
// of a name, `?` any one, `{a,b}` either; a leading `./` is the project root, a trailing `/` dropped. `within`:
// a path in a directory it matches too, as `secrets` all of secrets/.
export function globRegExp(glob, within = false) {
  let depth = 0
  let paired = true
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
      paired &&= depth > 0
      depth--
      return ')'
    }
    return RegExp.escape(part)
  }
  const source = glob.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '').replaceAll(/\*\*\/|\*\*|[*?{},]|[^*?{},]+/gu, token)
  if (!paired || depth !== 0) return null
  return new RegExp(within ? `^(?:${source})(?:/.*)?$` : `^${source}$`, 'u')
}

// Whether a glob of paths is one a path from the project root may match: relative, of `/`s, and with no `.`,
// `..` (but leading ones, out of the project) or empty name, which no such path has.
export function isPathGlob(glob) {
  if (glob === '' || isAbsolute(glob) || glob.includes('\\') || globRegExp(glob) === null) return false
  const names = glob.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '').split('/')
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

// (path) => the name of the package of a file: of one installed (installedOf()), the name its package.json
// has, as an npm alias ("nice": "npm:evil@1") installs it under another, else the one it is installed under;
// else of the nearest package.json that names one (the project's, a workspace package's); null where none
// does. Each directory looked up once, through `host` (build-host.js's, noting each file it reads for a watcher).
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

// (path, module) => the error of each rule the file at `path`, of the package `module` (packagesOf()'s), breaks;
// null where the config sets none. The rules are the top level's and those of the section of the build, a dev
// one's (`dev`) development's, a release one's production's: a section's add to the top level's, each checked
// on its own, as every rule is.
export function restrictionsOf(config, projectRoot, dev) {
  const mode = dev ? 'development' : 'production'
  const rules = [...rulesOf(config, ''), ...rulesOf(config[mode] ?? {}, `${mode}.`)]
  if (rules.length === 0) return null
  return (path, module) => {
    const name = relative(projectRoot, path).replaceAll('\\', '/')
    return rules.map((rule) => rule(name, module)).filter((error) => error !== null)
  }
}

// The rules of the restrictions `options` sets (the top level's, or a section's, its keys named after `prefix`),
// each (name, module) => its error, or null.
function rulesOf(options, prefix) {
  const globs = (key) => options[key].map((glob) => ({ glob, test: globRegExp(glob, key.endsWith('Paths')) }))
  const matching = (list, value) => list.find(({ test }) => test.test(value))
  const named = (key) => `${RN_CONFIG}'s ${prefix}${key}`
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
      return matching(allowed, module) ? null : `${name} is of ${module}, which matches none of ${named('allowedModules')}`
    })
  }
  if (options.disallowedModules !== undefined) {
    const disallowed = globs('disallowedModules')
    rules.push((name, module) => {
      const found = module === null ? undefined : matching(disallowed, module)
      return found === undefined ? null : `${name} is of ${module}, which matches ${JSON.stringify(found.glob)} of ${named('disallowedModules')}`
    })
  }
  return rules
}

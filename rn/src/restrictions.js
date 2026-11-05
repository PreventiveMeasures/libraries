// rn.config.json's allowedPaths, disallowedPaths, allowedModules and disallowedModules: the files a build may
// take, each rule checked on its own, a file breaking any of them an error. A path is a file's real path from
// the project root, a module the name of the package it is of (packagesOf()), each as globs match it
// (globRegExp()). With allowedModules, a file of no package is of none it allows.

import { dirname, join, relative } from 'node:path'

const RN_CONFIG = 'rn.config.json'

// A glob of a path from the project root as a RegExp, or null where its braces don't pair: `**` any path, dot
// files' too (unlike Node's path.matchesGlob, which pnpm's node_modules/.pnpm would fail), `*` any characters
// of a name, `?` any one, `{a,b}` either; a leading `./` is the project root.
export function globRegExp(glob) {
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
  const source = glob.replace(/^(?:\.\/)+/u, '').replaceAll(/\*\*\/|\*\*|[*?{},]|[^*?{},]+/gu, token)
  return paired && depth === 0 ? new RegExp(`^${source}$`, 'u') : null
}

// The package of a file at `path` by its innermost node_modules directory, or null where it is in none.
export function moduleOf(path) {
  const parts = path.split(/[/\\]/u)
  const at = parts.lastIndexOf('node_modules') + 1
  if (at === 0 || at === parts.length) return null
  return parts[at].startsWith('@') && at + 1 < parts.length - 1 ? `${parts[at]}/${parts[at + 1]}` : parts[at]
}

// (path) => the name of the package of a file: by its innermost node_modules directory (moduleOf()), else of
// the nearest package.json that names one (the project's, a workspace package's); null where none does. Each
// directory looked up once, through `host` (build-host.js's, noting each file it reads for a watcher).
export function packagesOf(host) {
  const named = new Map()
  const nameIn = (dir) => {
    if (!named.has(dir)) named.set(dir, manifestName(host, join(dir, 'package.json')) ?? (dirname(dir) === dir ? null : nameIn(dirname(dir))))
    return named.get(dir)
  }
  return (path) => moduleOf(path) ?? nameIn(dirname(path))
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
// null where the config sets none.
export function restrictionsOf(config, projectRoot) {
  const globs = (key) => config[key].map((glob) => ({ glob, test: globRegExp(glob) }))
  const matching = (list, value) => list.find(({ test }) => test.test(value))
  const rules = []
  if (config.allowedPaths !== undefined) {
    const allowed = globs('allowedPaths')
    rules.push((name) => (matching(allowed, name) ? null : `${name} matches none of ${RN_CONFIG}'s allowedPaths`))
  }
  if (config.disallowedPaths !== undefined) {
    const disallowed = globs('disallowedPaths')
    rules.push((name) => {
      const found = matching(disallowed, name)
      return found === undefined ? null : `${name} matches ${JSON.stringify(found.glob)} of ${RN_CONFIG}'s disallowedPaths`
    })
  }
  if (config.allowedModules !== undefined) {
    const allowed = globs('allowedModules')
    rules.push((name, module) => {
      if (module === null) return `${name} is of no package (no package.json above it has a name), which ${RN_CONFIG}'s allowedModules allows none of`
      return matching(allowed, module) ? null : `${name} is of ${module}, which matches none of ${RN_CONFIG}'s allowedModules`
    })
  }
  if (config.disallowedModules !== undefined) {
    const disallowed = globs('disallowedModules')
    rules.push((name, module) => {
      const found = module === null ? undefined : matching(disallowed, module)
      return found === undefined ? null : `${name} is of ${module}, which matches ${JSON.stringify(found.glob)} of ${RN_CONFIG}'s disallowedModules`
    })
  }
  if (rules.length === 0) return null
  return (path, module) => {
    const name = relative(projectRoot, path).replaceAll('\\', '/')
    return rules.map((rule) => rule(name, module)).filter((error) => error !== null)
  }
}

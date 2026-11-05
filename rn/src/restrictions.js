// rn.config.json's allowedPaths, disallowedPaths, allowedModules and disallowedModules: the files a build may
// take, each rule checked on its own, a file breaking any of them an error. A path is a file's real path from
// the project root, as globs match it (globRegExp()). A module is the package a file is in, by its innermost
// node_modules directory: a file in none (the project's, a workspace package's) is restricted by paths alone.

import { relative } from 'node:path'

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

// The package of a file at `name` from the project root, or null.
export function moduleOf(name) {
  const parts = name.split('/')
  const at = parts.lastIndexOf('node_modules') + 1
  if (at === 0 || at === parts.length) return null
  return parts[at].startsWith('@') && at + 1 < parts.length - 1 ? `${parts[at]}/${parts[at + 1]}` : parts[at]
}

// (path) => the error of each rule the file at `path` breaks; null where the config sets none.
export function restrictionsOf(config, projectRoot) {
  const globs = (key) => config[key].map((glob) => ({ glob, test: globRegExp(glob) }))
  const rules = []
  if (config.allowedPaths !== undefined) {
    const allowed = globs('allowedPaths')
    rules.push((name) => (allowed.some(({ test }) => test.test(name)) ? null : `${name} matches none of ${RN_CONFIG}'s allowedPaths`))
  }
  if (config.disallowedPaths !== undefined) {
    const disallowed = globs('disallowedPaths')
    rules.push((name) => {
      const found = disallowed.find(({ test }) => test.test(name))
      return found === undefined ? null : `${name} matches ${JSON.stringify(found.glob)} of ${RN_CONFIG}'s disallowedPaths`
    })
  }
  if (config.allowedModules !== undefined) {
    const allowed = new Set(config.allowedModules)
    rules.push((name, module) => (module === null || allowed.has(module) ? null : `${name} is of ${module}, which ${RN_CONFIG}'s allowedModules lacks`))
  }
  if (config.disallowedModules !== undefined) {
    const disallowed = new Set(config.disallowedModules)
    rules.push((name, module) => (module !== null && disallowed.has(module) ? `${name} is of ${module}, which ${RN_CONFIG}'s disallowedModules has` : null))
  }
  if (rules.length === 0) return null
  return (path) => {
    const name = relative(projectRoot, path).replaceAll('\\', '/')
    const module = moduleOf(name)
    return rules.map((rule) => rule(name, module)).filter((error) => error !== null)
  }
}

// The errors of `restrict` (restrictionsOf()'s) of each file of the module `found` (resolvedModule()'s).
export function forbidden(restrict, found) {
  if (restrict === null || found === null || found.kind === 'empty') return []
  return (found.files ?? [found.key]).flatMap(restrict)
}

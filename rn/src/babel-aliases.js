// babel-plugin-module-resolver 5's `alias` option, mapped as the plugin maps
// it, so a bundler can take a project's aliases without running Babel.

import { dirname, relative, resolve } from 'node:path'

const isRelativePath = (path) => /^\.?\.\//u.test(path)
const escapeRegExp = (string) => string.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// Unflagged, as the plugin builds them: `u` would refuse some patterns it takes.
function matcher(key, value) {
  if (!key.startsWith('^') && !key.endsWith('$')) {
    // eslint-disable-next-line require-unicode-regexp
    return [new RegExp(`^${escapeRegExp(key)}(/.*|)$`), ([, rest]) => `${value}${rest}`]
  }
  let regExp
  try {
    // eslint-disable-next-line require-unicode-regexp
    regExp = new RegExp(key)
  } catch (cause) {
    throw new SyntaxError(`${JSON.stringify(key)} is not a valid regular expression`, { cause })
  }
  const parts = value.split('\\\\')
  return [regExp, (groups) => parts.map((part) => part.replaceAll(/\\\d+/gu, (n) => groups[n.slice(1)] || '')).join('\\')]
}

export function createAliases(alias, cwd) {
  if (alias === null || typeof alias !== 'object' || Array.isArray(alias) || !Object.values(alias).every((value) => typeof value === 'string')) {
    throw new TypeError('alias must be an object mapping each alias to a string')
  }
  const matchers = Object.entries(alias).map(([key, value]) => matcher(key, value))
  return (file, specifier) => {
    if (isRelativePath(specifier)) return null
    for (const [regExp, substitute] of matchers) {
      const groups = regExp.exec(specifier)
      if (groups === null) continue
      const mapped = substitute(groups)
      if (!mapped) return null
      if (!isRelativePath(mapped)) return mapped === specifier ? null : mapped
      const local = relative(dirname(file), resolve(cwd, mapped)).replaceAll('\\', '/').replace(/\/index$/u, '')
      return isRelativePath(local) ? local : `./${local}`
    }
    return null
  }
}

// babel-plugin-module-resolver 5's `alias` option, mapped as the plugin maps it,
// so a bundler can apply a project's aliases without running Babel.

import { dirname, relative, resolve } from 'node:path'

const isRelativePath = (path) => /^\.?\.\//u.test(path)

// A key that is no pattern matches as the plugin's `^key(/.*|)$` would.
function matcher(key, value) {
  if (!key.startsWith('^') && !key.endsWith('$')) {
    const exec = (specifier) => {
      if (!specifier.startsWith(key)) return null
      const rest = specifier.slice(key.length)
      // `.` matches no line terminator.
      return rest === '' || (rest.startsWith('/') && !/[\n\r\u2028\u2029]/u.test(rest)) ? [specifier, rest] : null
    }
    return [{ exec }, ([, rest]) => `${value}${rest}`]
  }
  let regExp
  try {
    // No `u`, as the plugin builds it: `u` would reject some patterns it accepts.
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
    if (isRelativePath(specifier) || specifier === '.') return null
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

// createAliases() of a file's { alias, cwd } (load.js), made once per object and per value,
// since a load cache restores equal copies; null where createAliases() throws.
export function aliasing(of) {
  if (!OF.has(of)) {
    const key = JSON.stringify([of.alias, of.cwd])
    if (!MADE.has(key)) {
      try {
        MADE.set(key, createAliases(of.alias, of.cwd))
      } catch {
        MADE.set(key, null)
      }
    }
    OF.set(of, MADE.get(key))
  }
  return OF.get(of)
}
const MADE = new Map()
const OF = new WeakMap()

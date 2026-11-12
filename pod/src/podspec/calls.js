// The calls a podspec read without Ruby may make: File's, Dir.glob and JSON.parse; ENV and globals; and the
// helpers of the lockfile's React Native, rn.js's.

import { dirname, isAbsolute, resolve } from 'node:path'

import { PodError } from '../error.js'
import { toMaps } from './json.js'
import { changed, expect, fail, is, next } from './parse.js'
import { HELPERS, KNOWN, reactNative } from './rn.js'

function readFile(p, path) {
  const file = isAbsolute(path) ? resolve(path) : resolve(p.dir, path)
  const content = p.files.read(file)
  if (content === undefined) throw new PodError(`its podspec reads ${file}, which is not there`, p.where)
  return content
}

// `File.<method>(...)`, `Dir.glob(...)` and `JSON.parse(...)`, from the podspec's directory, as CocoaPods reads
// a podspec in it. Files are read and listed, never run.
export function call(p, receiver, method, args) {
  const strings = args.every((arg) => typeof arg === 'string')
  const one = strings && args.length === 1
  if (receiver === 'File' && method === 'join' && strings) return args.join('/').replaceAll(/\/+/gu, '/')
  if (receiver === 'File' && method === 'dirname' && one) return dirname(args[0])
  if (receiver === 'File' && method === 'expand_path' && strings && args.length <= 2) return resolve(args[1] ?? p.dir, args[0])
  if (receiver === 'File' && method === 'read' && one) return readFile(p, args[0])
  if (receiver === 'Dir' && method === 'glob' && one && p.files.glob !== undefined) return p.files.glob(p.dir, args[0], p.where)
  if (['exist?', 'exists?'].includes(method) && receiver !== 'JSON' && one && p.files.kind !== undefined) {
    const kind = p.files.kind(resolve(p.dir, args[0]))
    return receiver === 'Dir' ? kind === 'directory' : kind !== undefined
  }
  if (receiver === 'JSON' && method === 'parse' && one) {
    try {
      // JSON.parse puts integer keys first, so a package.json with one is not read as Ruby reads it.
      return toMaps(JSON.parse(args[0]), () => fail(p, 'a package.json with a number for a key'))
    } catch (error) {
      if (error instanceof PodError) throw error
      throw new PodError('its podspec reads as JSON what is not', p.where, { cause: error })
    }
  }
  return fail(p, `the call \`${receiver}.${method}\``)
}

// The lockfile's React Native, for `what` of the podspec; refused where its version is not known.
function reactNativeOf(p, token, what) {
  const version = p.context.reactNative
  const known = version === undefined ? undefined : reactNative(version)
  if (known !== undefined) return known
  throw new PodError(`line ${token.line}: ${what} needs React Native ${KNOWN}, ${version === undefined ? 'and the lockfile has none' : `not ${version}`}`, p.where)
}

// `ENV['NAME']`: as pod.config.json's `env` gives it; else as the lockfile's React Native leaves it once
// use_react_native! has run; else not set, null. What is read is recorded in `p.env`.
export function environment(p, name, token) {
  let value = null
  if (p.context.env.has(name)) value = p.context.env.get(name)
  else if (p.context.reactNative !== undefined) {
    const known = reactNativeOf(p, token, `\`ENV['${name}']\` without pod.config.json's \`env\``)
    if (known.podfile.has(name)) throw new PodError(`line ${token.line}: \`ENV['${name}']\` comes from the Podfile: give it in pod.config.json's \`env\``, p.where)
    value = known.env(p.context)[name] ?? null
  }
  p.env.set(name, value)
  return value
}

export const isHelper = (name) => HELPERS.has(name)

// A global as `[value]` where it is set: by this podspec, else by the Podfile, as `globals` gives it. One that
// another podspec set is not known.
function globalOf(p, name) {
  if (p.globals.has(name)) return [p.globals.get(name)]
  return p.context.globals?.has(name) ? [p.context.globals.get(name)] : []
}
// `$name`, or nil.
export function global(p, token) {
  const [value = null] = globalOf(p, token.value)
  p.env.set(`$${token.value}`, typeof value === 'string' || value === null ? value : JSON.stringify(value) ?? 'a hash')
  return value
}

// The helper of the lockfile's React Native, or undefined where that version has none of the name.
function helperOf(p, token, name = token.value) {
  return reactNativeOf(p, token, `\`${name}\``).helpers[name]
}

// One of React Native's helpers, called with `args` in their places and `options` by name.
export function helper(p, token, args, options) {
  const called = helperOf(p, token) ?? fail(p, `\`${token.value}\`, which React Native ${p.context.reactNative} has not`, token)
  p.helpers.add(token.value)
  if (args.some((arg) => arg?.attributes instanceof Map)) changed(p)
  return called({ args, options, env: (name) => environment(p, name, token), prebuilt: p.context.prebuilt, refuse: (what) => fail(p, what, token) })
}

// `defined?(name)` and `respond_to?(:name, true)`: of a helper, whether the lockfile's React Native has it; of a
// global, whether it is set; and of CocoaPods' `Pod::UI`, which is there.
export function defined(p, token) {
  const responds = token.value === 'respond_to?'
  const parenthesized = is(p, '(')
  if (parenthesized) next(p)
  const ui = is(p, 'name', 'Pod') && p.tokens[p.at + 1].type === '::' && p.tokens[p.at + 2].value === 'UI'
  if (!responds && (ui || is(p, 'global'))) {
    const of = next(p)
    if (ui) p.at += 2
    if (parenthesized) expect(p, ')')
    if (ui) return 'expression'
    const set = globalOf(p, of.value).length > 0
    p.env.set(`$${of.value}`, set ? 'set' : null)
    return set ? 'global-variable' : null
  }
  const name = expect(p, responds ? 'symbol' : 'name').value
  if (responds) {
    // A helper is a private method, which respond_to? has only where told to.
    expect(p, ',')
    expect(p, 'name', 'true')
  } else if (is(p, '(')) {
    next(p)
    expect(p, ')')
  }
  if (parenthesized) expect(p, ')')
  if (!isHelper(name)) fail(p, `\`${token.value}\` of \`${name}\``, token)
  const has = p.context.reactNative !== undefined && helperOf(p, token, name) !== undefined
  if (responds) return has
  return has ? 'method' : null
}

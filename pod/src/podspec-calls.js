// What a podspec in the form podspec-read.js reads may call: File's, of paths and of a file's text, and
// JSON.parse; a variable of the environment; and React Native's helpers, podspec-rn.js's, as the version the
// lockfile has it at has them.

import { dirname, isAbsolute, resolve } from 'node:path'

import { PodError } from './error.js'
import { changed, expect, fail, is, next } from './podspec-parse.js'
import { HELPERS, KNOWN, reactNative } from './podspec-rn.js'

// A hash of a package.json as a podspec reads it: its keys in their order. One whose keys are numbers, which
// JSON.parse puts first, is refused.
function fromJson(p, value) {
  if (Array.isArray(value)) return value.map((item) => fromJson(p, item))
  if (value === null || typeof value !== 'object') return value
  if (Object.keys(value).some((key) => /^(?:0|[1-9]\d*)$/u.test(key))) fail(p, 'a package.json with a number for a key')
  return new Map(Object.entries(value).map(([key, item]) => [key, fromJson(p, item)]))
}

function readFile(p, path) {
  const file = isAbsolute(path) ? resolve(path) : resolve(p.dir, path)
  const content = p.files.read(file)
  if (content === undefined) throw new PodError(`its podspec reads ${file}, which is not there`, p.where)
  return content
}

// `File.<method>(...)`, `Dir.glob(...)` and `JSON.parse(...)`. A file is read, and files are listed, from the
// podspec's directory, as CocoaPods reads a podspec in it; nothing of them is run.
export function call(p, receiver, method, args) {
  const strings = args.every((arg) => typeof arg === 'string')
  if (receiver === 'File' && method === 'join' && strings) return args.join('/').replaceAll(/\/+/gu, '/')
  if (receiver === 'File' && method === 'dirname' && strings && args.length === 1) return dirname(args[0])
  if (receiver === 'File' && method === 'expand_path' && strings && args.length <= 2) return resolve(args[1] ?? p.dir, args[0])
  if (receiver === 'File' && method === 'read' && strings && args.length === 1) return readFile(p, args[0])
  if (receiver === 'Dir' && method === 'glob' && strings && args.length === 1 && p.files.glob !== undefined) return p.files.glob(p.dir, args[0], p.where)
  // `File.exist?(path)` and `Dir.exist?(path)`: whether there is a file, or a directory, there.
  if (['exist?', 'exists?'].includes(method) && receiver !== 'JSON' && strings && args.length === 1 && p.files.kind !== undefined) {
    const kind = p.files.kind(resolve(p.dir, args[0]))
    return receiver === 'Dir' ? kind === 'directory' : kind !== undefined
  }
  if (receiver === 'JSON' && method === 'parse' && strings && args.length === 1) {
    try {
      return fromJson(p, JSON.parse(args[0]))
    } catch (error) {
      if (error instanceof PodError) throw error
      throw new PodError('its podspec reads as JSON what is not', p.where, { cause: error })
    }
  }
  return fail(p, `the call \`${receiver}.${method}\``)
}

// React Native's part as the version the lockfile has it at has it, for `what` of the podspec, which is refused
// where that is no version it is known of.
function reactNativeOf(p, token, what) {
  const version = p.context.reactNative
  const known = version === undefined ? undefined : reactNative(version)
  if (known !== undefined) return known
  throw new PodError(`line ${token.line}: ${what}, which is known only of React Native ${KNOWN}: the lockfile has ${version === undefined ? 'no React-Core' : `React-Core at ${version}`}`, p.where)
}

// `ENV['NAME']`: what pod.config.json's `env` gives, null for one that is not set; else what the lockfile's
// React Native leaves there once a Podfile's use_react_native! has run, and not set where it has none.
export function environment(p, name, token) {
  let value = null
  if (p.context.env.has(name)) value = p.context.env.get(name)
  else if (p.context.reactNative !== undefined) {
    const known = reactNativeOf(p, token, `\`ENV['${name}']\` is not given by pod.config.json's \`env\`, and is then as React Native leaves it`)
    if (known.podfile.has(name)) throw new PodError(`line ${token.line}: \`ENV['${name}']\` is as the Podfile had it, which pod.config.json's \`env\` has to give`, p.where)
    value = known.env(p.context)[name] ?? null
  }
  p.env.set(name, value)
  return value
}

export const isHelper = (name) => HELPERS.has(name)

// A global, `$name`, in a list of its own where it is set: as this podspec set it; else as pod.config.json's
// `globals` gives it, which is as a Podfile set it. One that another podspec set is not known.
function globalOf(p, name) {
  if (p.globals.has(name)) return [p.globals.get(name)]
  return p.context.globals?.has(name) ? [p.context.globals.get(name)] : []
}
// `$name`: the global, or nil.
export function global(p, token) {
  const [value = null] = globalOf(p, token.value)
  p.env.set(`$${token.value}`, typeof value === 'string' || value === null ? value : JSON.stringify(value) ?? 'a hash')
  return value
}

// The helper `token` names, of the lockfile's React Native, or undefined where that version has none of the
// name; refused where the version is not known.
function helperOf(p, token, name = token.value) {
  return reactNativeOf(p, token, `\`${name}\` is React Native's`).helpers[name]
}

// One of React Native's helpers, called with `args` in their places and `options` by name.
export function helper(p, token, args, options) {
  const called = helperOf(p, token) ?? fail(p, `\`${token.value}\`, which React Native ${p.context.reactNative} has not`, token)
  p.helpers.add(token.value)
  if (args.some((arg) => arg?.attributes instanceof Map)) changed(p)
  return called({ args, options, env: (name) => environment(p, name, token), prebuilt: p.context.prebuilt, refuse: (what) => fail(p, what, token) })
}

// `defined?(name)` and `respond_to?(:name, true)`, of one of React Native's helpers: whether the Podfile had
// it, which is whether the lockfile's React Native has it.
export function defined(p, token) {
  const responds = token.value === 'respond_to?'
  const parenthesized = is(p, '(')
  if (parenthesized) next(p)
  // Of a global, whether it is set; and of CocoaPods' own `Pod::UI`, which is there.
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
    // A helper is a private method, which respond_to? has only where it is told to.
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

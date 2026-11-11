// An .xcconfig as Xcodeproj's Config holds one: OTHER_LDFLAGS taken apart into what it links, so that two merged
// name each once.

import { PodError } from '../error.js'
import { byBytes } from '../order.js'

const INHERITED = new Set(['$(inherited)', '${inherited}'])
const FLAG_KEYS = ['simple', 'frameworks', 'weak_frameworks', 'libraries', 'arg_files', 'force_load']
const FLAG_OPTIONS = { '-framework': 'frameworks', '-weak_framework': 'weak_frameworks', '-l': 'libraries', '@': 'arg_files', '-force_load': 'force_load' }
// A word as Ruby's Shellwords.split reads one: bare, in single or double quotes, or escaped.
const WORD = /\s*(?:([^\0\s\\'"]+)|'([^\0']*)'|"((?:[^\0"\\]|\\[^\0])*)"|(\\[^\0]?)|(\S))(\s)?/gsuy

function shellsplit(line) {
  const words = []
  let field = ''
  WORD.lastIndex = 0
  for (let match = WORD.exec(line); match !== null && match[0] !== ''; match = WORD.exec(line)) {
    const [, word, single, double, escaped, garbage, separator] = match
    if (garbage !== undefined) throw new PodError(`an unmatched quote in ${JSON.stringify(line)}`)
    field += word ?? single ?? double?.replaceAll(/\\([$`"\\\n])/gu, '$1') ?? escaped.replaceAll(/\\(.)/gsu, '$1')
    // A word ends at a space, or with the line.
    if (separator !== undefined || WORD.lastIndex === line.length) {
      words.push(field)
      field = ''
    }
  }
  return words
}

// OtherLinkerFlagsParser.parse.
function parseLinkerFlags(flags) {
  const result = Object.fromEntries(FLAG_KEYS.map((key) => [key, []]))
  let key
  const tokens = shellsplit(flags.trim()).flatMap((word) => (/^-l./u.test(word) ? ['-l', word.slice(2)] : /^@./u.test(word) ? ['@', word.slice(1)] : [word]))
  for (const token of tokens) {
    if (Object.hasOwn(FLAG_OPTIONS, token)) key = FLAG_OPTIONS[token]
    else if (key === undefined) result.simple.push(token)
    else {
      result[key].push(token)
      key = undefined
    }
  }
  return result
}

export function newConfig(settings) {
  const config = { attributes: {}, flags: Object.fromEntries(FLAG_KEYS.map((key) => [key, new Set()])) }
  mergeSettings(config, settings)
  return config
}

// Config#merge! of a hash: a setting both have is kept where one holds the other's words, and joined otherwise.
export function mergeSettings(config, settings) {
  for (const [key, given] of Object.entries(settings)) {
    if (!Object.hasOwn(config.attributes, key)) {
      config.attributes[key] = given
      continue
    }
    const one = config.attributes[key].trim()
    const two = given.trim()
    const first = shellsplit(one)
    const second = shellsplit(two)
    const starts = (longer, shorter) => shorter.every((word, i) => longer[i] === word)
    if (second.every((word) => first.includes(word)) || (second.length <= first.length && starts(first, second))) config.attributes[key] = one
    else if (first.length <= second.length && starts(second, first)) config.attributes[key] = two
    else config.attributes[key] = `${one} ${two}`
  }
  if (Object.hasOwn(config.attributes, 'OTHER_LDFLAGS')) {
    const parsed = parseLinkerFlags(config.attributes.OTHER_LDFLAGS)
    delete config.attributes.OTHER_LDFLAGS
    for (const key of FLAG_KEYS) for (const flag of parsed[key]) config.flags[key].add(flag)
  }
  return config
}

// Config#to_hash: OTHER_LDFLAGS put together again, less each setting that only inherits.
function settingsOf(config) {
  const sorted = (key) => [...config.flags[key]].sort(byBytes)
  const list = [
    ...sorted('simple'),
    ...sorted('libraries').map((name) => `-l"${name}"`),
    ...sorted('frameworks').map((name) => `-framework "${name}"`),
    ...sorted('weak_frameworks').map((name) => `-weak_framework "${name}"`),
    ...sorted('arg_files').map((name) => `@"${name}"`),
    ...sorted('force_load').map((name) => `-force_load ${name}`),
  ]
  const result = { ...config.attributes }
  if (list.length > 0) result.OTHER_LDFLAGS = list.join(' ')
  for (const [key, value] of Object.entries(result)) if (INHERITED.has(String(value).trim())) delete result[key]
  return result
}

export function configText(config) {
  const lines = Object.entries(settingsOf(config)).sort(([a], [b]) => byBytes(a, b)).map(([key, value]) => `${key} = ${value}`.trim())
  return `${lines.join('\n')}\n`
}

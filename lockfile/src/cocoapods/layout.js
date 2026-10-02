// The text CocoaPods' YAMLHelper writes for what yaml.js read, which a
// Podfile.lock has to be, byte for byte, but for line ends: YAMLHelper's
// convert_hash and what it calls, with the quoting of strings of the
// CocoaPods release that wrote the file. What it would lay out otherwise
// — another order, another quoting, another spacing — is refused, which
// leaves each value one way to be written.

import { LockfileError, quote } from '../error.js'
import { compareCodePoints } from './order.js'

// The sections a Podfile.lock lays out first, in this order, a blank line
// between each.
export const SECTIONS = ['PODS', 'DEPENDENCIES', 'SPEC REPOS', 'EXTERNAL SOURCES', 'CHECKOUT OPTIONS', 'SPEC CHECKSUMS', 'PODFILE CHECKSUM', 'COCOAPODS']

// The strings YAMLHelper single-quotes, as YAML would type them: from 1.5,
// null, booleans and numbers; from 1.10, yes, no, on and off; from 1.13,
// dates and times.
const TAGS = new Set(['null', 'Null', 'NULL', '~', '', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE'])
const YES_NO = new Set(['yes', 'Yes', 'YES', 'no', 'No', 'NO', 'on', 'On', 'ON', 'off', 'Off', 'OFF'])
const NUMBERS = [
  /^[-+]?\d+$/u,
  /^00[0-7]+$/u,
  /^0x[\dA-Fa-f]+$/u,
  /^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?$/u,
  /^[-+]?\.(?:inf|Inf|INF)$/u,
  /^\.(?:nan|NaN|NAN)$/u,
]
// YAMLHelper builds this one from a string, where `\.` is `.`: the
// fraction of a second is any character and the digits after it.
const DATES = /^(?:\d{4}-\d\d-\d\d|\d{4}-\d\d?-\d\d?(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)$/u

const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/u
const PLAIN = /^\w[\w/ ()~<>=.:`,-]*$/u

function resolved(text, rules) {
  if (TAGS.has(text) || NUMBERS.some((re) => re.test(text))) return true
  return (rules.yesNo && YES_NO.has(text)) || (rules.dates && DATES.test(text))
}

// Ruby's String#inspect of a string of printable characters alone, which
// is all yaml.js reads.
export const inspect = (text) => `"${text.replace(/["\\]/gu, '\\$&').replace(/#(?=[{$@])/gu, '\\#')}"`

function processString(text, rules) {
  if (resolved(text, rules)) return `'${text}'`
  if (/^[ \t\n\v\f\r]*$/u.test(text) || INDICATOR.test(text) || text.endsWith(':')) return inspect(text)
  return PLAIN.test(text) ? text : inspect(text)
}

// YAMLHelper's sorting_string: what an entry sorts by, its case folded as
// Ruby's String#downcase folds it, a character at a time.
const downcase = (text) => Array.from(text, (char) => char.toLowerCase()).join('')

function sortingString(node) {
  if (node.kind === 'seq') return node.items.length === 0 ? '' : sortingString(node.items[0])
  if (node.kind === 'map') return node.entries.map(({ key }) => downcase(String(key.value))).sort(compareCodePoints)[0] ?? ''
  if (node.type === 'boolean') {
    if (node.value) throw new LockfileError(`true at line ${node.line + 1}, which YAMLHelper fails to sort`)
    return ''
  }
  return downcase(node.value)
}

// Sorted by what each sorts by, and as they were where that is the same.
function sorted(nodes) {
  const keyed = nodes.map((node, index) => [sortingString(node), index, node])
  return keyed.sort((a, b) => compareCodePoints(a[0], b[0]) || a[1] - b[1]).map((item) => item[2])
}

function processScalar(node, rules) {
  if (node.type === 'symbol') return `:${node.value}`
  if (node.type === 'boolean') return String(node.value)
  return processString(node.value, rules)
}

const isCollection = (node) => node.kind !== 'scalar'
const size = (node) => (node.kind === 'seq' ? node.items.length : node.entries.length)

// Each of YAMLHelper's process_ methods ends with a strip, of no effect on
// what yaml.js reads.
function processNode(node, rules) {
  if (node.kind === 'seq') return processArray(node.items, rules)
  if (node.kind === 'map') return processHash(node.entries, rules)
  return processScalar(node, rules)
}

function processArray(items, rules) {
  if (items.length === 0) return '[]'
  const result = sorted(items).map((item) => {
    const processed = processNode(item, rules)
    if (!isCollection(item) || size(item) <= 1) return processed
    const [head, ...rest] = processed.split('\n')
    return [head, ...rest.map((line) => `  ${line}`)].join('\n')
  })
  return `- ${result.join('\n- ')}`
}

function processHash(entries, rules, hint, separator = '\n') {
  if (entries.length === 0) return '{}'
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  let keys = sorted(entries.map((entry) => entry.key))
  if (hint !== undefined) {
    const hinted = hint.flatMap((name) => keys.filter((key) => key.type === 'string' && key.value === name))
    keys = [...hinted, ...keys.filter((key) => !hinted.includes(key))]
  }
  return keys.map((key) => {
    const { value } = byKey.get(key)
    const processed = processNode(value, rules)
    if (!isCollection(value)) return `${processScalar(key, rules)}: ${processed}`
    return `${processScalar(key, rules)}:\n${processed.split('\n').map((line) => `  ${line}`).join('\n')}`
  }).join(separator)
}

// The text the CocoaPods of `rules` writes for `root`, with its line ends.
export function layout(root, rules, crlf) {
  const text = `${processHash(root.entries, rules, SECTIONS, '\n\n')}\n`
  return crlf ? text.replaceAll('\n', '\r\n') : text
}

export function checkLayout(text, root, rules, crlf, writer) {
  const expected = layout(root, rules, crlf)
  if (text === expected) return
  const end = crlf ? '\r\n' : '\n'
  const [have, want] = [text.split(end), expected.split(end)]
  const line = want.findIndex((item, index) => item !== have[index])
  const as = `as CocoaPods ${writer} writes it`
  if (line === have.length) throw new LockfileError(`line ${line}: expected a line end, ${as}`)
  if (line === -1 || line === want.length - 1) throw new LockfileError(`line ${line === -1 ? want.length : line + 1}: expected the end of the file, ${as}`)
  throw new LockfileError(`line ${line + 1}: expected ${quote(want[line])}, ${as}, found ${quote(have[line])}`)
}

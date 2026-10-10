// The text CocoaPods' YAMLHelper writes for what yaml.js read, which a
// Podfile.lock has to be, byte for byte, but for line ends: YAMLHelper's
// convert_hash and what it calls, with the quoting of strings of the
// CocoaPods release that wrote the file. What it would lay out otherwise
// -- another order, another quoting, another spacing -- is refused, which
// leaves each value one way to be written.

import { LockfileError, quote } from '../error.js'
import { fail } from '../lines.js'
import { compareCodePoints } from '../order.js'

// The sections a Podfile.lock lays out first, in this order, a blank line
// between each.
export const SECTIONS = ['PODS', 'DEPENDENCIES', 'SPEC REPOS', 'EXTERNAL SOURCES', 'CHECKOUT OPTIONS', 'SPEC CHECKSUMS', 'PODFILE CHECKSUM', 'COCOAPODS']

// The strings YAMLHelper single-quotes, as YAML would type them: from 1.5,
// null, booleans and numbers; from 1.10, yes, no, on and off; from 1.13,
// dates and times. `rulesOf` says which, of CocoaPods 1.`minor`.
export const rulesOf = (minor) => ({ yesNo: minor >= 10, dates: minor >= 13 })
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
// A string YAMLHelper writes plain, and a symbol as YAML.dump writes one.
export const PLAIN = /^\w[\w/ ()~<>=.:`,-]*$/u
export const SYMBOL = /^:[a-z_][a-z0-9_]*$/u

function resolved(text, rules) {
  if (TAGS.has(text) || NUMBERS.some((re) => re.test(text))) return true
  return (rules.yesNo && YES_NO.has(text)) || (rules.dates && DATES.test(text))
}

// Ruby's String#inspect of a string of printable characters alone, which
// is all yaml.js reads: as JSON writes it, but for a `#` before `{`, `$`
// or `@`, which Ruby escapes.
export const inspect = (text) => JSON.stringify(text).replace(/#(?=[{$@])/gu, '\\#')

function processString(text, rules) {
  if (resolved(text, rules)) return `'${text}'`
  if (/^[ \t\n\v\f\r]*$/u.test(text) || INDICATOR.test(text) || text.endsWith(':')) return inspect(text)
  return PLAIN.test(text) ? text : inspect(text)
}

// YAMLHelper's sorting_string: what an entry sorts by, its case folded as
// Ruby's String#downcase folds it, a character at a time. Of JS's case
// mappings only a final sigma's depends on what is around it, and Ruby's
// does not: a capital sigma is U+03C3, never the final U+03C2, wherever
// it is.
const downcase = (text) => text.replaceAll('\u03A3', '\u03C3').toLowerCase()

function sortingString(node) {
  if (node.kind === 'seq') return node.items.length === 0 ? '' : sortingString(node.items[0])
  if (node.kind === 'map') return node.entries.map(({ key }) => downcase(String(key.value))).sort(compareCodePoints)[0] ?? ''
  if (node.type === 'boolean') {
    if (node.value) throw fail('true, which YAMLHelper fails to sort', node.line)
    return ''
  }
  return downcase(node.value)
}

// Sorted by what the node of each sorts by, and as they were where that
// is the same, as JS sorts.
function sorted(list, nodeOf = (item) => item) {
  return list.map((item) => [sortingString(nodeOf(item)), item]).sort((a, b) => compareCodePoints(a[0], b[0])).map(([, item]) => item)
}

function processScalar(node, rules) {
  if (node.type === 'symbol') return `:${node.value}`
  if (node.type === 'boolean') return String(node.value)
  return processString(node.value, rules)
}

const isCollection = (node) => node.kind !== 'scalar'
const size = (node) => (node.kind === 'seq' ? node.items.length : node.entries.length)
// Every line but the first two spaces deeper.
const indent = (text) => text.replaceAll('\n', '\n  ')

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
    return isCollection(item) && size(item) > 1 ? indent(processed) : processed
  })
  return `- ${result.join('\n- ')}`
}

function processHash(entries, rules, hint, separator = '\n') {
  if (entries.length === 0) return '{}'
  let ordered = sorted(entries, (entry) => entry.key)
  if (hint !== undefined) {
    const hinted = hint.flatMap((name) => ordered.filter(({ key }) => key.type === 'string' && key.value === name))
    ordered = [...hinted, ...ordered.filter((entry) => !hinted.includes(entry))]
  }
  return ordered.map(({ key, value }) => {
    const processed = processNode(value, rules)
    return isCollection(value) ? `${processScalar(key, rules)}:\n  ${indent(processed)}` : `${processScalar(key, rules)}: ${processed}`
  }).join(separator)
}

// The text the CocoaPods of `rules` writes for `root`.
export const layout = (root, rules) => `${processHash(root.entries, rules, SECTIONS, '\n\n')}\n`

export function checkLayout(text, root, rules, crlf, writer) {
  const written = layout(root, rules)
  const expected = crlf ? written.replaceAll('\n', '\r\n') : written
  if (text === expected) return
  const end = crlf ? '\r\n' : '\n'
  const [have, want] = [text.split(end), expected.split(end)]
  const line = want.findIndex((item, index) => item !== have[index])
  const as = `as CocoaPods ${writer} writes it`
  if (line === have.length) throw new LockfileError(`line ${line}: expected a line end, ${as}`)
  if (line === -1 || line === want.length - 1) throw new LockfileError(`line ${line === -1 ? want.length : line + 1}: expected the end of the file, ${as}`)
  throw new LockfileError(`line ${line + 1}: expected ${quote(want[line])}, ${as}, found ${quote(have[line])}`)
}

// How the three places an external source shows in a Podfile.lock hold
// together: DEPENDENCIES describes each, as Dependency#to_s does, from the
// options EXTERNAL SOURCES has; CHECKOUT OPTIONS has what CocoaPods
// downloaded each by, which follows from those options.

import { LockfileError, quote } from '../error.js'
import { inspect } from './layout.js'
import { DOWNLOADS, fieldOf } from './sources.js'

// Dependency#external_source_description, but for a source it writes with
// Hash#inspect, whose order is the Podfile's, which the lockfile does not
// keep: undefined.
function describe(source) {
  if (source.type === 'git') {
    const refs = ['commit', 'branch', 'tag'].filter((ref) => source[ref] !== undefined).map((ref) => `, ${ref} \`${source[ref]}\``)
    return `from \`${source.url}\`${refs.join('')}`
  }
  if (source.type === 'hg' || source.type === 'svn') return `from \`${source.url}\``
  if (source.type === 'podspec' || source.type === 'path') return `from \`${source[source.type]}\``
  return undefined
}

const inspectValue = (node) => {
  if (node.kind === 'seq') return `[${node.items.map((item) => inspect(item.value)).join(', ')}]`
  return node.type === 'boolean' ? String(node.value) : inspect(node.value)
}

const STRING = String.raw`"(?:[^"\\]|\\.)*"`
const ENTRY = new RegExp(String.raw`(?::(\w+)=>|(\w+): )(${STRING}|true|false|\[(?:${STRING}(?:, ${STRING})*)?\])(?:, |$)`, 'uy')
const ITEMS = new RegExp(STRING, 'gu')

// The entries of Ruby's Hash#inspect of symbols, `{:http=>"...", :type=>
// "tgz"}`, or from Ruby 3.4 `{http: "...", type: "tgz"}`, by key: one
// style throughout.
function readInspected(inner) {
  const entries = new Map()
  const styles = new Set()
  if (inner.endsWith(', ')) return undefined
  ENTRY.lastIndex = 0
  while (ENTRY.lastIndex < inner.length) {
    const m = ENTRY.exec(inner)
    if (m === null || entries.has(m[1] ?? m[2])) return undefined
    styles.add(m[1] === undefined)
    entries.set(m[1] ?? m[2], m[3])
  }
  return styles.size === 1 ? entries : undefined
}

// A sequence's items, in any order: EXTERNAL SOURCES has them sorted.
const sameItems = (a, b) => JSON.stringify((a.match(ITEMS) ?? []).sort()) === JSON.stringify((b.match(ITEMS) ?? []).sort())

function matchesInspected(description, options) {
  const m = /^from `\{(.+)\}`$/u.exec(description)
  const entries = m === null ? undefined : readInspected(m[1])
  if (entries === undefined || entries.size !== Object.keys(options).length) return false
  return Object.entries(options).every(([name, { node }]) => {
    const written = entries.get(name)
    if (written === undefined) return false
    return node.kind === 'seq' ? written.startsWith('[') && sameItems(written, inspectValue(node)) : written === inspectValue(node)
  })
}

// Whether `description`, of a dependency of the Podfile, is the one
// Dependency#to_s writes of the external source read from `options`.
export function checkDescription(description, source, options, where) {
  const expected = describe(source)
  if (expected === undefined ? matchesInspected(description, options) : description === expected) return
  const what = expected === undefined ? 'the options of EXTERNAL SOURCES, as Ruby\'s Hash#inspect writes them' : quote(expected)
  throw new LockfileError(`${quote(description)} is not ${what}, as CocoaPods describes the external source`, where)
}

const PINS = { git: 'commit', hg: 'revision', svn: 'revision' }

// CocoaPods keeps the options a pod was downloaded by where they name
// what to download, a commit or a revision, or a tag, and those of a file
// always; else what the download came to, by the same URL: a commit or a
// revision, and with git, submodules where they were asked for. A branch
// git resolves to a commit first. A pod by `:path` it downloads not at all,
// and a pod by `:podspec` by whatever source the podspec names.
export function checkCheckout(external, checkout, where, externalWhere) {
  if (external.type === 'path') {
    if (checkout !== undefined) throw new LockfileError('checkout options of a pod by :path, which CocoaPods keeps none of', where)
    return
  }
  if (external.type === 'podspec') return
  if (checkout === undefined) throw new LockfileError(`no checkout options, which CocoaPods keeps of a pod by :${external.type}`, externalWhere)
  if (checkout.type !== external.type || checkout.url !== external.url) throw new LockfileError(`not by the :${external.type} and URL EXTERNAL SOURCES has`, where)
  const fields = DOWNLOADS[external.type].map(fieldOf)
  const pin = PINS[external.type]
  if (pin === undefined) {
    if (fields.some((field) => JSON.stringify(checkout[field]) !== JSON.stringify(external[field]))) throw new LockfileError('other than the options EXTERNAL SOURCES has, which CocoaPods keeps as they are of a file', where)
    return
  }
  if (checkout[pin] === undefined && checkout.tag === undefined) throw new LockfileError(`neither a ${pin} nor a tag, one of which CocoaPods keeps`, where)
  const other = fields.find((field) => field !== pin && checkout[field] !== undefined && checkout[field] !== external[field])
  if (other !== undefined) throw new LockfileError(`another ${other} than EXTERNAL SOURCES has`, where)
  if (external[pin] !== undefined && external.branch === undefined && checkout[pin] !== external[pin]) throw new LockfileError(`another ${pin} than EXTERNAL SOURCES has`, where)
  if (external.submodules === true && checkout.submodules !== true) throw new LockfileError('without submodules, which EXTERNAL SOURCES asks for', where)
}

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

// A file's options, as EXTERNAL SOURCES has them, by name.
const optionsOf = (source) => [[source.type, source.url], ...DOWNLOADS[source.type].map((option) => [option, source[fieldOf(option)]])].filter(([, value]) => value !== undefined)

const inspectValue = (value) => (typeof value === 'boolean' ? String(value) : inspect(value))

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
const sameItems = (written, values) => JSON.stringify((written.match(ITEMS) ?? []).sort()) === JSON.stringify(values.map(inspect).sort())

function matchesInspected(description, source) {
  const m = /^from `\{(.+)\}`$/u.exec(description)
  const entries = m === null ? undefined : readInspected(m[1])
  const options = optionsOf(source)
  if (entries === undefined || entries.size !== options.length) return false
  return options.every(([name, value]) => {
    const written = entries.get(name)
    if (written === undefined) return false
    return Array.isArray(value) ? written.startsWith('[') && sameItems(written, value) : written === inspectValue(value)
  })
}

// Whether `description`, of a dependency of the Podfile, is the one
// Dependency#to_s writes of `source`.
export function checkDescription(description, source, where) {
  const expected = describe(source)
  if (expected === undefined ? matchesInspected(description, source) : description === expected) return
  const what = expected === undefined ? 'the options of EXTERNAL SOURCES, as Ruby\'s Hash#inspect writes them' : quote(expected)
  throw new LockfileError(`${quote(description)} is not ${what}, as CocoaPods describes the external source`, where)
}

const PINS = { git: 'commit', hg: 'revision', svn: 'revision' }
// Any value, where CocoaPods keeps what the download came to.
const ANY = Symbol('any')

// What CocoaPods may keep of a download by `external`: its options, where
// they name what to download, a commit or a revision, or a tag; else the
// commit or the revision it came to, and with git, `:submodules` where
// they were asked for. A git branch is resolved to a commit first where
// git finds it, and kept where it does not.
function keptOf(external) {
  const { type, url, tag, submodules } = external
  const pin = PINS[type]
  const kept = external[pin] !== undefined || tag !== undefined ? external : { type, url, [pin]: ANY, submodules: submodules || undefined }
  return type === 'git' && external.branch !== undefined ? [{ ...external, branch: undefined, commit: ANY }, kept] : [kept]
}

// The first option `checkout` has otherwise than `kept`, and how.
function differenceOf(checkout, kept) {
  for (const option of DOWNLOADS[checkout.type]) {
    const [have, want] = [checkout[fieldOf(option)], kept[fieldOf(option)]]
    if (want === ANY ? have !== undefined : have === want) continue
    if (have === undefined) return `no :${option}, which CocoaPods keeps of this download`
    if (want === undefined) return `a :${option}, which CocoaPods does not keep of this download`
    return `another :${option} than EXTERNAL SOURCES has`
  }
  return undefined
}

// CocoaPods keeps the options a file was downloaded by as they are, and of
// git, hg and svn what keptOf says. A pod by `:path` it downloads not at
// all, and a pod by `:podspec` by whatever source the podspec names.
export function checkCheckout(external, checkout, where, externalWhere) {
  if (external.type === 'path') {
    if (checkout !== undefined) throw new LockfileError('checkout options of a pod by :path, which CocoaPods keeps none of', where)
    return
  }
  if (external.type === 'podspec') return
  if (checkout === undefined) throw new LockfileError(`no checkout options, which CocoaPods keeps of a pod by :${external.type}`, externalWhere)
  if (checkout.type !== external.type || checkout.url !== external.url) throw new LockfileError(`not by the :${external.type} and URL EXTERNAL SOURCES has`, where)
  if (PINS[external.type] === undefined) {
    const fields = DOWNLOADS[external.type].map(fieldOf)
    if (fields.some((field) => JSON.stringify(checkout[field]) !== JSON.stringify(external[field]))) throw new LockfileError('other than the options EXTERNAL SOURCES has, which CocoaPods keeps as they are of a file', where)
    return
  }
  const differences = keptOf(external).map((kept) => differenceOf(checkout, kept))
  if (!differences.includes(undefined)) throw new LockfileError(differences[0], where)
}

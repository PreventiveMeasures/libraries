// Cargo finds a vendored package by the name and version its Cargo.toml
// gives, not by its directory's name.

import { LockfileError, at, quote } from '../error.js'
import { isHexSha256, isSegment, isWithin } from '../names.js'
import { field, isMapping } from '../shape.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { checkCrateName, checkCrateVersion, table } from './shape.js'

function identify(text, where) {
  const doc = table(parseToml(text), where)
  const here = at(where, doc.package === undefined ? 'project' : 'package')
  const pkg = table(doc.package ?? doc.project, here)
  const name = checkCrateName(pkg.name, at(here, 'name'))
  if (isTable(pkg.version)) throw new LockfileError('a vendored package inherits nothing from a workspace', at(here, 'version'))
  return { name, version: field(pkg, 'version', here, checkCrateVersion) ?? '0.0.0' }
}

// JSON.parse would take the last of a key given twice.
function parseJson(text, where) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LockfileError(`not JSON: ${error.message}`, where)
  }
  // A key is a string a colon follows.
  let written = 0
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?/gsu)) if (match[1] !== undefined) written++
  const count = (item) => {
    if (typeof item !== 'object' || item === null) return 0
    const values = Object.values(item)
    return (Array.isArray(item) ? 0 : values.length) + values.reduce((sum, x) => sum + count(x), 0)
  }
  if (written !== count(value)) throw new LockfileError('a key is given twice', where)
  return value
}

// `package` is null for a git source; cargo 1.9x adds a `$comment`.
function readChecksum(text, where) {
  const value = parseJson(text, where)
  if (!isMapping(value)) throw new LockfileError('expected an object', where)
  if (value.$comment !== undefined && typeof value.$comment !== 'string') throw new LockfileError('expected "$comment" to be a string', where)
  const keys = Object.keys(value).filter((key) => key !== '$comment').sort().join()
  if (keys !== 'files,package') throw new LockfileError('expected "files" and "package", and nothing else', where)
  if (value.package !== null && !isHexSha256(value.package)) throw new LockfileError('expected "package" to be a sha256 or null', where)
  if (!isMapping(value.files)) throw new LockfileError('expected "files" to be an object', where)
  const files = Object.create(null)
  for (const [path, sum] of Object.entries(value.files)) {
    if (!isWithin(path)) throw new LockfileError(`${quote(path)} is not a path within the package`, where)
    if (typeof sum !== 'string' || !isHexSha256(sum)) throw new LockfileError(`expected a sha256 for ${quote(path)}`, where)
    files[path] = sum
  }
  return { checksum: value.package ?? undefined, files }
}

// One `.cargo-checksum.json`, as readCargoVendor reads each.
export function parseCargoChecksum(text) {
  if (typeof text !== 'string') throw new TypeError('expected the text of a .cargo-checksum.json')
  return readChecksum(text, undefined)
}

// `vendor`: the directories a directory source reads, every one not starting
// with `.` that holds a Cargo.toml.
export function readCargoVendor(lock, vendor) {
  if (typeof vendor !== 'object' || vendor === null) throw new TypeError('expected the vendor directory, by directory')
  const found = new Map()
  for (const [directory, entry] of Object.entries(vendor)) {
    if (!isSegment(directory) || directory.startsWith('.')) throw new LockfileError(`${quote(directory)} is not a directory a directory source reads`, directory)
    if (typeof entry?.manifest !== 'string' || typeof entry.checksum !== 'string') throw new TypeError(`expected the manifest and checksum texts of ${quote(directory)}`)
    const { name, version } = identify(entry.manifest, at(directory, 'Cargo.toml'))
    const id = `${name} ${version}`
    if (found.has(id)) throw new LockfileError(`${quote(found.get(id).directory)} holds ${quote(id)} too, and cargo would read either`, directory)
    found.set(id, { directory, ...readChecksum(entry.checksum, at(directory, '.cargo-checksum.json')) })
  }
  const vendored = Object.create(null)
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (pkg.source === undefined) continue
    const copy = found.get(`${pkg.name} ${pkg.version}`)
    if (copy === undefined) throw new LockfileError(`no directory holds ${quote(`${pkg.name} ${pkg.version}`)}`, key)
    if (copy.checksum !== pkg.checksum) {
      throw new LockfileError(`${quote(copy.directory)} holds it with checksum ${copy.checksum ?? 'none'}, where the lockfile has ${pkg.checksum ?? 'none'}`, key)
    }
    vendored[key] = { directory: copy.directory, files: copy.files }
  }
  return vendored
}

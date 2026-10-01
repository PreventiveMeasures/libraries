// A vendor directory as `cargo vendor` writes it and a directory source
// reads it: a directory per package, named anything, holding the package's
// Cargo.toml and a `.cargo-checksum.json`. Cargo finds a package by the
// name and version its Cargo.toml gives, not by the directory's name, so
// neither is taken here from the name: `serde` may hold 1.0.200 and
// `serde-1.0.100` the other. Two directories that hold one version of one
// package are refused, as cargo would read either; so is a vendored package
// whose checksum is not the lockfile's, which cargo refuses.

import { parseVersion } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { checkName, string, table } from './shape.js'

const SHA256 = /^[\da-f]{64}$/u
const SEGMENT = /^(?!\.{1,2}$)[^\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}/\\]+$/u

// The name and version a vendored Cargo.toml gives, and nothing else of it:
// a published manifest inherits nothing, and has no version only where it
// is 0.0.0.
function identify(text, where) {
  const doc = table(parseToml(text), where)
  const pkg = doc.package ?? doc.project
  const here = at(where, doc.package === undefined ? 'project' : 'package')
  table(pkg, here)
  const name = checkName(pkg.name, at(here, 'name'))
  if (isTable(pkg.version)) throw new LockfileError('a vendored package inherits nothing from a workspace', at(here, 'version'))
  const version = pkg.version === undefined ? '0.0.0' : string(pkg.version, at(here, 'version'))
  if (parseVersion(version) === undefined) throw new LockfileError(`${quote(version)} is not a version`, at(here, 'version'))
  return { name, version }
}

// JSON with no key given twice, which JSON.parse would read as the last.
function parseJson(text, where) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new LockfileError(`not JSON: ${error.message}`, where)
  }
  // Every string in the text, in turn; a key is one a colon follows.
  const written = [...text.matchAll(/"(?:[^"\\]|\\.)*"(\s*:)?/gsu)].filter((m) => m[1] !== undefined).length
  const count = (item) => {
    if (typeof item !== 'object' || item === null) return 0
    const values = Object.values(item)
    return (Array.isArray(item) ? 0 : values.length) + values.reduce((sum, x) => sum + count(x), 0)
  }
  if (written !== count(value)) throw new LockfileError('a key is given twice', where)
  return value
}

// `.cargo-checksum.json`: the checksum of the package as the lockfile has
// it, null for a git one, and a sha256 of each file by its path; and, from
// cargo 1.9x, a `$comment` on what the file is for.
function readChecksum(text, where) {
  const value = parseJson(text, where)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LockfileError('expected an object', where)
  if (value.$comment !== undefined && typeof value.$comment !== 'string') throw new LockfileError('expected "$comment" to be a string', where)
  const keys = Object.keys(value).filter((key) => key !== '$comment').sort().join()
  if (keys !== 'files,package') throw new LockfileError('expected "files" and "package", and nothing else', where)
  if (value.package !== null && !SHA256.test(value.package)) throw new LockfileError('expected "package" to be a sha256 or null', where)
  if (typeof value.files !== 'object' || value.files === null || Array.isArray(value.files)) throw new LockfileError('expected "files" to be an object', where)
  const files = Object.create(null)
  for (const [path, sum] of Object.entries(value.files)) {
    if (!path.split('/').every((segment) => SEGMENT.test(segment))) throw new LockfileError(`${quote(path)} is not a path within the package`, where)
    if (typeof sum !== 'string' || !SHA256.test(sum)) throw new LockfileError(`expected a sha256 for ${quote(path)}`, where)
    files[path] = sum
  }
  return { checksum: value.package ?? undefined, files }
}

// `vendor` is by directory: every one a directory source reads, which is
// every one not starting with `.` that holds a Cargo.toml.
export function readCargoVendor(lock, vendor) {
  if (typeof vendor !== 'object' || vendor === null) throw new TypeError('expected the vendor directory, by directory')
  const found = new Map()
  for (const [directory, entry] of Object.entries(vendor)) {
    if (!SEGMENT.test(directory) || directory.startsWith('.')) throw new LockfileError(`${quote(directory)} is not a directory a directory source reads`, directory)
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

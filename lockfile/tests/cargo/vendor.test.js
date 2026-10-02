import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseCargoLock, readCargoVendor } from '../../cargo.js'

// A lockfile with two versions of one package from crates.io, a git package
// and a path one, and a vendor directory as `cargo vendor` writes it for
// them; then one change at a time, each of which is refused.

const SUM = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const COMMIT = 'c'.repeat(40)
const CRATES = 'registry+https://github.com/rust-lang/crates.io-index'
const GIT = `git+https://github.com/x/log#${COMMIT}`

const lock = parseCargoLock(`version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["log", "rand 0.7.3", "rand 0.8.5"]

[[package]]
name = "log"
version = "0.4.0"
source = "${GIT}"

[[package]]
name = "rand"
version = "0.7.3"
source = "${CRATES}"
checksum = "${SUM}"

[[package]]
name = "rand"
version = "0.8.5"
source = "${CRATES}"
checksum = "${OTHER}"
`)

const manifest = (name, version) => `[package]\nname = "${name}"\nversion = "${version}"\n`
const checksum = (pkg, files) => JSON.stringify({ files: files ?? { 'Cargo.toml': SUM }, package: pkg })

// Named against cargo vendor's habit: the older version under the bare name.
const VENDOR = {
  rand: { manifest: manifest('rand', '0.7.3'), checksum: checksum(SUM) },
  'rand-0.8.5': { manifest: manifest('rand', '0.8.5'), checksum: checksum(OTHER, { 'src/lib.rs': OTHER }) },
  log: { manifest: manifest('log', '0.4.0'), checksum: checksum(null) },
  unused: { manifest: manifest('unused', '1.0.0'), checksum: checksum(SUM) },
}

describe('readCargoVendor', () => {
  it('finds each package by the name and version inside, not the directory\'s name', () => {
    const vendored = readCargoVendor(lock, VENDOR)
    assert.deepEqual(Object.keys(vendored), [`log 0.4.0 (${GIT})`, `rand 0.7.3 (${CRATES})`, `rand 0.8.5 (${CRATES})`])
    assert.equal(vendored[`rand 0.7.3 (${CRATES})`].directory, 'rand')
    assert.equal(vendored[`rand 0.8.5 (${CRATES})`].directory, 'rand-0.8.5')
    assert.deepEqual({ ...vendored[`rand 0.8.5 (${CRATES})`].files }, { 'src/lib.rs': OTHER })
  })

  it('takes the $comment cargo 1.9x writes', () => {
    const vendor = { ...VENDOR, log: { ...VENDOR.log, checksum: JSON.stringify({ $comment: 'not a security mechanism', files: {}, package: null }) } }
    assert.equal(readCargoVendor(lock, vendor)[`log 0.4.0 (${GIT})`].directory, 'log')
  })

  it('takes a manifest with no version as 0.0.0', () => {
    const zero = parseCargoLock(`version = 4\n[[package]]\nname = "a"\nversion = "0.1.0"\ndependencies = ["z"]\n[[package]]\nname = "z"\nversion = "0.0.0"\nsource = "${CRATES}"\nchecksum = "${SUM}"\n`)
    assert.equal(readCargoVendor(zero, { z: { manifest: '[package]\nname = "z"\n', checksum: checksum(SUM) } })[`z 0.0.0 (${CRATES})`].directory, 'z')
  })

  it('throws a TypeError for an entry that is not two texts', () => {
    assert.throws(() => readCargoVendor(lock, { ...VENDOR, rand: { manifest: VENDOR.rand.manifest } }), TypeError)
  })

  const refused = [
    ['one version in two directories', { ...VENDOR, 'rand-0.7.3': VENDOR.rand }, 'rand-0.7.3: "rand" holds "rand 0.7.3" too, and cargo would read either'],
    ['a package missing', { ...VENDOR, log: undefined }, `log 0.4.0 (${GIT}): no directory holds "log 0.4.0"`],
    ['a checksum not the lockfile\'s', { ...VENDOR, rand: { ...VENDOR.rand, checksum: checksum(OTHER) } }, `rand 0.7.3 (${CRATES}): "rand" holds it with checksum ${OTHER}, where the lockfile has ${SUM}`],
    ['a checksum on a git package', { ...VENDOR, log: { ...VENDOR.log, checksum: checksum(SUM) } }, `log 0.4.0 (${GIT}): "log" holds it with checksum ${SUM}, where the lockfile has none`],
    ['a directory starting with .', { ...VENDOR, '.git': VENDOR.log }, '.git: ".git" is not a directory a directory source reads'],
    ['a manifest that inherits', { ...VENDOR, log: { ...VENDOR.log, manifest: '[package]\nname = "log"\nversion.workspace = true\n' } }, 'log["Cargo.toml"].package.version: a vendored package inherits nothing from a workspace'],
    ['checksums that are not JSON', { ...VENDOR, log: { ...VENDOR.log, checksum: '{' } }, /^log\[".cargo-checksum.json"\]: not JSON: /u],
    ['a key given twice', { ...VENDOR, log: { ...VENDOR.log, checksum: `{"package":"${SUM}","files":{},"package":null}` } }, 'log[".cargo-checksum.json"]: a key is given twice'],
    ['a file given twice', { ...VENDOR, log: { ...VENDOR.log, checksum: `{"package":null,"files":{"a":"${SUM}","a":"${SUM}"}}` } }, 'log[".cargo-checksum.json"]: a key is given twice'],
    ['a key it does not know', { ...VENDOR, log: { ...VENDOR.log, checksum: JSON.stringify({ files: {}, package: null, signed: true }) } }, 'log[".cargo-checksum.json"]: expected "files" and "package", and nothing else'],
    ['a path out of the directory', { ...VENDOR, log: { ...VENDOR.log, checksum: checksum(null, { '../x': SUM }) } }, 'log[".cargo-checksum.json"]: "../x" is not a path within the package'],
    ['a file checksum that is not a sha256', { ...VENDOR, log: { ...VENDOR.log, checksum: checksum(null, { 'a.rs': 'x' }) } }, 'log[".cargo-checksum.json"]: expected a sha256 for "a.rs"'],
  ]
  for (const [title, vendor, message] of refused) {
    it(`refuses ${title}`, () => {
      const present = Object.fromEntries(Object.entries(vendor).filter(([, entry]) => entry !== undefined))
      assert.throws(() => readCargoVendor(lock, present), (error) => error instanceof LockfileError && (typeof message === 'string' ? error.message === message : message.test(error.message)))
    })
  }
})

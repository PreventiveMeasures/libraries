import assert from 'node:assert/strict'
import { cpuUsage } from 'node:process'
import { describe, it } from 'node:test'
import { LockfileError, parsePackageResolved } from '../../swiftpm.js'
import { random } from '../random.js'
import { FIXTURES } from './fixtures.js'
import { write } from './write.js'

// The fixtures with edits at random: a piece put in, characters taken out
// or swapped for a piece, or two lines swapped. Whatever is refused is
// refused with a LockfileError; whatever is read, JSON.parse reads alike,
// and SwiftPM writes again of what was read byte for byte, but its line
// ends. The seed is fixed, so a failure names its document and comes back
// on a rerun.

const BASES = Object.values(FIXTURES).map((run) => run.resolved)

const PIECES = [
  ' ', '  ', '\n', '\r\n', '"', '\\', ',', ':', ' : ', ': ', '{', '}', '[', ']', 'null', '0', '1', '3', 'a', 'A', '.', '/', '-', '_', '~',
  '@', '.git', '\u00E9', '\u0301', '\u202E', 'version', 'branch', 'revision', 'identity', 'registry', 'localSourceControl', '\\u0041', '\\/',
  '\\n', '\\"', '\t', '\uFEFF', 'https://', 'file://', 'git@x:', '__proto__', '10', 'Z',
]

function edit({ next, pick }, text) {
  let out = text
  for (let count = 1 + Math.floor(next() * 3); count > 0; count--) {
    const pos = Math.floor(next() * (out.length + 1))
    const r = next()
    if (r < 0.35) out = `${out.slice(0, pos)}${pick(PIECES)}${out.slice(pos)}`
    else if (r < 0.6) out = `${out.slice(0, pos)}${out.slice(pos + 1 + Math.floor(next() * 4))}`
    else if (r < 0.85) out = `${out.slice(0, pos)}${pick(PIECES)}${out.slice(pos + 1)}`
    else {
      const lines = out.split('\n')
      const [a, b] = [Math.floor(next() * lines.length), Math.floor(next() * lines.length)]
      ;[lines[a], lines[b]] = [lines[b], lines[a]]
      out = lines.join('\n')
    }
  }
  return out
}

describe('the fixtures edited at random', () => {
  it('refused with a LockfileError, or read as JSON.parse reads them and as SwiftPM writes them', () => {
    const rng = random(0x5_3D)
    let read = 0
    for (let index = 0; index < 20000; index++) {
      const doc = edit(rng, rng.pick(BASES))
      let resolved
      try {
        resolved = parsePackageResolved(doc)
      } catch (error) {
        if (!(error instanceof LockfileError)) assert.fail(`${JSON.stringify(doc)} threw ${error}`)
        continue
      }
      read++
      const again = write(resolved)
      assert.equal(again, doc.replaceAll('\r\n', '\n').replace(/\n*$/u, ''), `${JSON.stringify(doc)} is not as SwiftPM writes what was read of it`)
      assert.deepEqual(JSON.parse(again), JSON.parse(doc), `${JSON.stringify(doc)} is read otherwise by JSON.parse`)
    }
    // Most edits break the file; some leave one SwiftPM writes, as one in a
    // string of a name or a branch does.
    assert.ok(read > 100 && read < 2000, `${read} read`)
  })
})

// Milliseconds of CPU spent since `start`: what the work cost, which a
// machine busy with other tests stretches on the clock and not here.
const cpuMs = (start) => {
  const { user, system } = cpuUsage(start)
  return (user + system) / 1000
}

describe('the work, bound by the file', () => {
  const REV = 'e3da04078777e6a1b72ce19981fbd6539b0847d8'
  const pin = (identity, state) => ({ identity, kind: 'remoteSourceControl', location: `https://x.org/${identity}`, name: undefined, originalLocation: undefined, version: undefined, branch: undefined, revision: REV, ...state })
  const v2 = (pins) => `${write({ version: 2, originHash: undefined, pins })}\n`
  const LONG = 2 ** 20 - 64

  it('of many pins: linear', () => {
    const pins = Object.fromEntries(Array.from({ length: 50000 }, (_, index) => `p${String(index).padStart(5, '0')}`).map((identity) => [identity, pin(identity, { version: '1.0.0' })]))
    const text = v2(pins)
    const start = cpuUsage()
    assert.equal(Object.keys(parsePackageResolved(text).pins).length, 50000)
    const took = cpuMs(start)
    assert.ok(took < 2000, `${Math.round(took)} ms`)
  })

  it('of lines a megabyte long, read or refused at once', () => {
    const docs = [
      v2({ a: pin('a', { version: `1.0.0-${'a'.repeat(LONG)}` }) }),
      v2({ a: pin('a', { version: `1.0.0-${'a'.repeat(LONG)}!` }) }),
      v2({ a: pin('a', { branch: 'a/'.repeat(LONG / 2) }) }),
      v2({ a: pin('a', { branch: '"'.repeat(LONG / 2) }) }),
      v2({ a: { ...pin('a'), location: `ssh://${'a@'.repeat(LONG / 2)}` } }),
      v2({ a: { ...pin('a'), location: 'a'.repeat(LONG) } }),
      v2({ a: { ...pin('a'), identity: 'a-'.repeat(LONG / 2), kind: 'registry', location: undefined, revision: undefined, version: '1.0.0' } }),
    ]
    const start = cpuUsage()
    for (const doc of docs) {
      try {
        parsePackageResolved(doc)
      } catch (error) {
        assert.ok(error instanceof LockfileError, error)
      }
    }
    const took = cpuMs(start)
    assert.ok(took < 1000, `${Math.round(took)} ms`)
  })
})

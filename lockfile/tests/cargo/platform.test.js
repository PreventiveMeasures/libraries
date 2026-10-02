import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, matchCargoPlatform } from '../../cargo.js'

// A Linux platform as known in full, and as a bundler knows one: what the
// target sets, and not what rustflags or a profile may add.

const LINUX = { name: 'x86_64-unknown-linux-gnu', cfg: ['unix', 'target_family="unix"', 'target_os="linux"', 'debug_assertions'] }
const TARGET = ['unix', 'windows', 'target_family', 'target_os']
const PART = { name: LINUX.name, cfg: LINUX.cfg.filter((line) => TARGET.includes(line.split('=')[0])), decides: TARGET }

const refusedWith = (message) => (error) => error instanceof LockfileError && error.message === message

describe('matchCargoPlatform', () => {
  it('matches a platform known in full as cargo does', () => {
    const on = matchCargoPlatform(LINUX)
    const tables = ['cfg(unix)', 'cfg(windows)', 'cfg(loom)', 'cfg(debug_assertions)', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']
    assert.deepEqual(tables.map(on), [true, false, false, true, true, false])
  })

  it('leaves undecided what a cfg it does not decide could turn either way', () => {
    const on = matchCargoPlatform(PART)
    const tables = {
      'cfg(unix)': true,
      'cfg(target_os = "macos")': false,
      'cfg(loom)': undefined,
      'cfg(debug_assertions)': undefined,
      'cfg(feature = "std")': undefined,
      'cfg(not(loom))': undefined,
      'cfg(all(unix, loom))': undefined,
      'cfg(all(windows, loom))': false,
      'cfg(any(unix, loom))': true,
      'cfg(any(windows, loom))': undefined,
      'cfg(not(all(windows, loom)))': true,
      'x86_64-unknown-linux-gnu': true,
    }
    assert.deepEqual(Object.fromEntries(Object.keys(tables).map((table) => [table, on(table)])), tables)
  })

  // Kleene's logic: each occurrence of a cfg undecided apart.
  it('leaves undecided what holds or fails whatever an undecided cfg is', () => {
    const on = matchCargoPlatform(PART)
    assert.deepEqual(['cfg(any(loom, not(loom)))', 'cfg(all(loom, not(loom)))'].map(on), [undefined, undefined])
  })

  it('takes a cfg it lists as holding, whether it decides the name or not', () => {
    assert.equal(matchCargoPlatform({ name: undefined, cfg: ['loom'], decides: [] })('cfg(loom)'), true)
  })

  it('leaves a table for a target by name undecided where the name is not known', () => {
    const on = matchCargoPlatform({ name: undefined, cfg: PART.cfg, decides: TARGET })
    assert.deepEqual(['x86_64-unknown-linux-gnu', 'cfg(unix)', 'cfg(true)', 'cfg(any())'].map(on), [undefined, true, true, false])
  })

  it('refuses a table\'s platform cargo does not read, and a platform that is not one', () => {
    assert.throws(() => matchCargoPlatform(LINUX)('cfg(not(a, b))'), refusedWith('"cfg(not(a, b))" is neither a target\'s name nor a cfg(…) cargo reads'))
    assert.throws(() => matchCargoPlatform({ name: undefined, cfg: ['a b'] }), refusedWith('platform: "a b" is not a line of `rustc --print cfg`'))
    assert.throws(() => matchCargoPlatform({ name: undefined, cfg: [], decides: ['target_os="linux"'] }), refusedWith('platform.decides: "target_os=\\"linux\\"" is not the name of a cfg'))
  })

  it('throws a TypeError for anything but a platform, and a table\'s platform that is not a string', () => {
    assert.throws(() => matchCargoPlatform(undefined), TypeError)
    assert.throws(() => matchCargoPlatform({ name: 'x' }), TypeError)
    assert.throws(() => matchCargoPlatform({ name: 1, cfg: [] }), TypeError)
    assert.throws(() => matchCargoPlatform({ name: 'x', cfg: [], decides: 'unix' }), TypeError)
    assert.throws(() => matchCargoPlatform(LINUX)(undefined), TypeError)
  })
})

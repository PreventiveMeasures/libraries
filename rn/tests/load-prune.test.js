import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createPack } from '../src/load-pack.js'
import { GRACE, STALE, prune } from '../src/load-prune.js'
import { writeTree } from './fixtures.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.now()

describe('prune', () => {
  const { root, cleanup } = writeTree({})
  after(cleanup)
  let made = 0
  // A cache of these packs ({ [name]: { ago, size, files } }: last used so
  // long ago, a segment of `size` bytes, and other files of it, each [name,
  // written so long ago]), entries ({ [name]: last used so long ago }) and
  // directories of entries of the layout before: each directory's mtime that
  // of its last use.
  const cacheOf = ({ packs = {}, entries = {}, legacy = [] }) => {
    const dir = join(root, `cache-${made++}`)
    const stamp = (path, ago) => utimesSync(path, new Date(NOW - ago), new Date(NOW - ago))
    for (const [name, { ago, size = 1, files = [] }] of Object.entries(packs)) {
      const path = join(dir, 'packs', name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'a.pack'), 'x'.repeat(size))
      for (const [file, fileAgo] of files) {
        writeFileSync(join(path, file), 'x')
        stamp(join(path, file), fileAgo)
      }
      stamp(path, ago)
    }
    for (const [name, ago] of Object.entries(entries)) {
      const path = join(dir, 'entries', name)
      mkdirSync(join(path, 'ab'), { recursive: true })
      writeFileSync(join(path, 'ab', 'cd'), '{}')
      stamp(path, ago)
    }
    for (const name of legacy) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'cd'), '{}')
    }
    return dir
  }
  const left = (dir, of) => (existsSync(join(dir, of)) ? readdirSync(join(dir, of)).toSorted() : [])

  it('removes the packs and entries no run has used for STALE, and those alone', async () => {
    const dir = cacheOf({ packs: { old: { ago: STALE + HOUR }, used: { ago: STALE - HOUR } }, entries: { old: STALE + HOUR, used: HOUR } })
    await prune(dir, { now: NOW })
    assert.deepEqual([left(dir, 'packs'), left(dir, 'entries')], [['used'], ['used']])
  })

  it('removes the least lately used packs while they take more than the budget, but of those a run used of the last GRACE', async () => {
    const packs = { a: { ago: 2 * HOUR, size: 40 }, b: { ago: 3 * HOUR, size: 40 }, c: { ago: 4 * HOUR, size: 40 }, d: { ago: 5 * HOUR, size: 10 } }
    let dir = cacheOf({ packs })
    await prune(dir, { now: NOW, budget: 100 })
    // a and b, 80 bytes; c more than the budget then, d not.
    assert.deepEqual(left(dir, 'packs'), ['a', 'b', 'd'])
    dir = cacheOf({ packs: { now: { ago: 0, size: 80 }, lately: { ago: GRACE / 2, size: 80 }, before: { ago: GRACE * 2, size: 10 } } })
    await prune(dir, { now: NOW, budget: 100 })
    assert.deepEqual(left(dir, 'packs'), ['lately', 'now'])
  })

  it('removes the entries of the layout before, and segments left half written of before GRACE', async () => {
    const dir = cacheOf({ packs: { used: { ago: 0, files: [['old.pack.tmp', GRACE * 2], ['now.pack.tmp', 0]] } }, legacy: ['0a', 'ff'] })
    await prune(dir, { now: NOW })
    assert.deepEqual([left(dir, ''), left(dir, 'packs/used')], [['packs'], ['a.pack', 'now.pack.tmp']])
  })

  it("removes a cache of rn-serve's before this one, the user's own, though not one of a link", async () => {
    const dir = cacheOf({})
    for (const name of ['before', 'target']) {
      mkdirSync(join(dir, name, 'ab'), { recursive: true })
      writeFileSync(join(dir, name, 'ab', 'cd'), '{}')
    }
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    await prune(dir, { before: [join(dir, 'before'), join(dir, 'link'), join(dir, 'none')] })
    assert.deepEqual(left(dir, ''), ['link', 'target'])
  })

  it('has none to remove of a cache not there', async () => {
    await prune(join(root, 'none'))
  })
})

describe("a pack's use", () => {
  const { root, cleanup } = writeTree({})
  after(cleanup)

  it('stamps its directory as a run reads it, and as it writes it', async () => {
    const dir = join(root, 'pack')
    const old = new Date(NOW - STALE)
    const pack = createPack(dir)
    pack.start()
    pack.set('0'.repeat(64), 'zero')
    await pack.finish()
    utimesSync(dir, old, old)
    const read = createPack(dir)
    read.start()
    await read.load()
    assert.equal(read.get('0'.repeat(64)), 'zero')
    assert.ok(Date.now() - statSync(dir).mtimeMs < HOUR)
    utimesSync(dir, old, old)
    await read.finish()
    assert.ok(Date.now() - statSync(dir).mtimeMs < HOUR)
  })
})

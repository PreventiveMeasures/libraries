// The fake mirrors an API whose every method returns a promise, including the ones with nothing to
// await — which is what the module under test calls `.catch()` on.
/* eslint-disable require-await */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { cacheKey } from '../src/cache.js'

// The OPFS half of #fs, over an in-memory Origin Private File System. The fake answers the shape OPFS
// specifies rather than the one this module happens to call, and comes in both flavours engines ship —
// with FileSystemHandle.move() and without — so the fallback paths run rather than being assumed.

class NotFound extends Error {
  constructor(name) {
    super(`A requested file or directory could not be found at the time an operation was processed: ${name}`)
    this.name = 'NotFoundError'
  }
}

// `createWritable` stages and commits on close, which is what writeAtomic leans on without move().
function fileHandle(dir, name, withMove) {
  const handle = {
    kind: 'file',
    name,
    getFile: async () => ({ text: async () => dir.files.get(name) }),
    createWritable: async () => {
      let staged = ''
      return {
        write: async (chunk) => { staged += chunk },
        close: async () => { dir.files.set(name, staged) },
      }
    },
  }
  if (withMove) {
    handle.move = async (destOrName, maybeName) => {
      const target = typeof destOrName === 'string' ? dir : destOrName
      const newName = typeof destOrName === 'string' ? destOrName : maybeName
      target.files.set(newName, dir.files.get(name))
      dir.files.delete(name)
    }
  }
  return handle
}

function directory(withMove) {
  const dir = {
    kind: 'directory',
    files: new Map(),
    dirs: new Map(),
    async getDirectoryHandle(name, { create = false } = {}) {
      // OPFS refuses a traversal segment outright; the fake does too, so a test cannot rely on one.
      assert.notEqual(name, '..', 'OPFS rejects `..`')
      if (!dir.dirs.has(name)) {
        if (!create) throw new NotFound(name)
        dir.dirs.set(name, directory(withMove))
      }
      return dir.dirs.get(name)
    },
    async getFileHandle(name, { create = false } = {}) {
      if (!dir.files.has(name)) {
        if (!create) throw new NotFound(name)
        dir.files.set(name, '')
      }
      return fileHandle(dir, name, withMove)
    },
    async removeEntry(name) {
      if (dir.files.delete(name) || dir.dirs.delete(name)) return
      throw new NotFound(name)
    },
    async *entries() {
      for (const name of dir.files.keys()) yield [name, { kind: 'file' }]
      for (const name of dir.dirs.keys()) yield [name, { kind: 'directory' }]
    },
  }
  if (withMove) {
    dir.move = async (destDir, newName) => { destDir.dirs.set(newName, dir) }
  }
  return dir
}

// `canMove` is probed on first write, so each flavour needs its own module instance; import() with a
// query gets one.
async function loadFs(withMove) {
  const root = directory(withMove)
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...previous, storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  })
  const url = new URL('../src/fs.browser.js', import.meta.url)
  url.search = `?move=${withMove}`
  return { fs: await import(url.href), restore: () => Object.defineProperty(globalThis, 'navigator', { value: previous, configurable: true, writable: true }) }
}

for (const withMove of [true, false]) {
  describe(`fs.browser.js over OPFS (engine ${withMove ? 'with' : 'without'} FileSystemHandle.move)`, () => {
    let fs, restore

    beforeEach(async () => { ({ fs, restore } = await loadFs(withMove)) })
    afterEach(() => restore())

    it('joins the paths cache.js builds, and drops what cannot mean anything', () => {
      assert.equal(fs.join('gpt-6', 'solidity-1a2b3c4d'), 'gpt-6/solidity-1a2b3c4d')
      assert.equal(fs.join('/cache', 'a', 'b.json'), 'cache/a/b.json')
      assert.equal(fs.join('a//b', './c'), 'a/b/c')
      assert.equal(fs.join(), '.')
    })

    it('reads back what it wrote, through the directories it created', async () => {
      await fs.ensureDir('cache/gpt-6/solidity-1a2b3c')
      await fs.writeAtomic('cache/gpt-6/solidity-1a2b3c/key.md', 'the answer')
      assert.equal(await fs.readText('cache/gpt-6/solidity-1a2b3c/key.md'), 'the answer')
      assert.equal(await fs.readTextOrNull('cache/gpt-6/solidity-1a2b3c/key.md'), 'the answer')
    })

    it('creates the directories a write needs, without a prior ensureDir', async () => {
      await fs.writeAtomic('deep/deeper/deepest/key.json', '[]')
      assert.equal(await fs.readText('deep/deeper/deepest/key.json'), '[]')
    })

    it('leaves no temp file behind', async () => {
      await fs.writeAtomic('a/key.md', 'text')
      const names = (await fs.readDirOrEmpty('a')).map((d) => d.name)
      assert.deepEqual(names, ['key.md'])
    })

    it('replaces an entry rather than appending to it', async () => {
      await fs.writeAtomic('a/key.md', 'first')
      await fs.writeAtomic('a/key.md', 'second')
      assert.equal(await fs.readText('a/key.md'), 'second')
    })

    it('reads a missing file, a missing directory and an empty file all as absent', async () => {
      await fs.ensureDir('a')
      await fs.writeAtomic('a/empty.md', '')
      assert.equal(await fs.readTextOrNull('a/empty.md'), null)
      assert.equal(await fs.readTextOrNull('a/nope.md'), null)
      assert.equal(await fs.readTextOrNull('no/such/dir/nope.md'), null)
    })

    it('throws for a missing file on the raw read, as the Node half does', async () => {
      await assert.rejects(fs.readText('a/nope.md'), { name: 'NotFoundError' })
    })

    it('lists entries with the file/directory distinction the scans read', async () => {
      await fs.writeAtomic('a/one.json', '{}')
      await fs.writeAtomic('a/two.md', 'text')
      await fs.ensureDir('a/sub')
      const entries = await fs.readDirOrEmpty('a')
      assert.deepEqual(entries.filter((d) => d.isFile()).map((d) => d.name).toSorted(), ['one.json', 'two.md'])
      assert.deepEqual(entries.filter((d) => d.isDirectory()).map((d) => d.name), ['sub'])
    })

    it('lists a directory that does not exist as empty', async () => {
      assert.deepEqual(await fs.readDirOrEmpty('no/such/dir'), [])
    })

    it('retitles a file in place, which is what invalidateCacheEntry does', async () => {
      await fs.writeAtomic('a/key.json', '[{"request":1}]')
      await fs.move('a/key.json', 'a/key.invalid.json')
      assert.equal(await fs.readTextOrNull('a/key.json'), null)
      assert.equal(await fs.readText('a/key.invalid.json'), '[{"request":1}]')
    })

    it('relocates a file across directories, which is what the legacy promotion does', async () => {
      await fs.writeAtomic('cache/old/sub/key.md', 'legacy')
      await fs.ensureDir('cache/sub')
      await fs.move('cache/old/sub/key.md', 'cache/sub/key.md')
      assert.equal(await fs.readText('cache/sub/key.md'), 'legacy')
      assert.equal(await fs.readTextOrNull('cache/old/sub/key.md'), null)
    })

    it('reports whether there was anything to move', async () => {
      await fs.writeAtomic('a/there.md', 'text')
      assert.equal(await fs.moveIfExists('a/there.md', 'a/moved.md'), true)
      assert.equal(await fs.moveIfExists('a/gone.md', 'a/moved2.md'), false)
      assert.equal(await fs.readText('a/moved.md'), 'text')
    })

    it('removes an entry, and tolerates one that is already gone', async () => {
      await fs.writeAtomic('a/key.md', 'text')
      await fs.removeIfExists('a/key.md')
      assert.equal(await fs.readTextOrNull('a/key.md'), null)
      await assert.doesNotReject(fs.removeIfExists('a/key.md'))
      await assert.doesNotReject(fs.removeIfExists('no/such/dir/key.md'))
      await assert.doesNotReject(fs.removeBestEffort('no/such/dir/key.md'))
    })

    it('addresses an entry the way the cache does, key and all', async () => {
      // The two halves of #fs have to agree on where an entry lives, or a cache written by one is
      // invisible to the other.
      const key = await cacheKey('a system prompt', 'some user content')
      const dir = fs.join('/cache', 'gpt-6', 'solidity-1a2b3c4d')
      await fs.writeAtomic(fs.join(dir, `${key}.json`), '[]')
      await fs.writeAtomic(fs.join(dir, `${key}.md`), 'answer')
      const names = (await fs.readDirOrEmpty(dir)).map((d) => d.name).toSorted()
      assert.deepEqual(names, [`${key}.json`, `${key}.md`])
      assert.equal(await fs.readText(fs.join(dir, `${key}.md`)), 'answer')
    })
  })
}

describe('fs.browser.js without move(): what it says it cannot do', () => {
  it('refuses a directory move rather than half-copying a tree', async () => {
    const { fs, restore } = await loadFs(false)
    try {
      await fs.writeAtomic('cache/old-type-1a2b3c/key.md', 'text')
      await assert.rejects(
        fs.move('cache/old-type-1a2b3c', 'cache/new-type-1a2b3c'),
        /no FileSystemHandle\.move\(\)/u,
      )
    } finally {
      restore()
    }
  })
})

describe('fs.browser.js with move(): a directory moves whole', () => {
  it('moves a type directory, which is what the one-shot migration needs', async () => {
    const { fs, restore } = await loadFs(true)
    try {
      await fs.writeAtomic('cache/old-type-1a2b3c/key.md', 'text')
      assert.equal(await fs.moveIfExists('cache/old-type-1a2b3c', 'cache/new-type-1a2b3c'), true)
      assert.equal(await fs.readText('cache/new-type-1a2b3c/key.md'), 'text')
    } finally {
      restore()
    }
  })

  it('reports a missing source directory as nothing to move', async () => {
    const { fs, restore } = await loadFs(true)
    try {
      assert.equal(await fs.moveIfExists('cache/never-existed-1a2b3c', 'cache/x-1a2b3c'), false)
    } finally {
      restore()
    }
  })
})

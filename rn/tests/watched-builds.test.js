import assert from 'node:assert/strict'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import esbuild from 'esbuild'

import { keptLookups, resolutionOf } from '../src/build-host.js'
import { diskHost } from '../src/defaults.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { createDevServer } from '../src/serve.js'
import { writeTree } from './fixtures.js'

describe('keptLookups', () => {
  it("keeps what it looked up after a file's contents change, a save by rename, or a path it never looked up added; not after a package.json changes, nor a path it looked up is added, removed or made another kind", () => {
    const { root, cleanup } = writeTree({ 'a/x.js': '', 'a/package.json': '{}', 'b/y.js': '' })
    try {
      const at = (path) => join(root, path)
      const kept = keptLookups(diskHost)
      const read = new Set()
      kept.attach(read)
      assert.deepEqual([kept.host.isFile(at('a/x.js')), kept.host.isFile(at('a/x.ios.js')), kept.host.isFile(at('b/y.js'))], [true, false, true])
      assert.deepEqual([...read].toSorted(), [at('a/x.ios.js'), at('a/x.js'), at('b/y.js')])
      // A later build's `read` has each path looked up before.
      const again = new Set()
      kept.attach(again)
      assert.equal(again.size, 3)
      assert.equal(kept.keeps([{ path: at('a/x.js'), event: 'change' }]), true)
      // An editor's save: another file renamed over it.
      writeFileSync(at('a/x.js.tmp'), 'saved')
      renameSync(at('a/x.js.tmp'), at('a/x.js'))
      assert.equal(kept.keeps([{ path: at('a/x.js.tmp'), event: 'rename' }, { path: at('a/x.js'), event: 'rename' }]), true)
      // One never looked up, added: its directory listed anew.
      writeFileSync(at('a/new.js'), '')
      assert.equal(kept.keeps([{ path: at('a/new.js'), event: 'rename' }]), true)
      assert.equal(kept.host.isFile(at('a/new.js')), true)
      writeFileSync(at('a/x.ios.js'), '')
      assert.equal(kept.keeps([{ path: at('a/x.ios.js'), event: 'rename' }]), false)
      assert.equal(kept.keeps([{ path: at('a/package.json'), event: 'change' }]), false)
      assert.equal(kept.keeps([{ path: at('b'), event: 'rename' }]), false)
      rmSync(at('a/x.js'))
      assert.equal(kept.keeps([{ path: at('a/x.js'), event: 'rename' }]), false)
    } finally {
      cleanup()
    }
  })
})

describe('resolutionOf', () => {
  it('resolves each import once across watcher-caused builds, and anew of a full build or of changes it no longer holds after', () => {
    const { root, cleanup } = writeTree({ 'index.js': '', 'a.js': '', 'package.json': '{}' })
    try {
      let lookups = 0
      const host = { ...diskHost, dirents: (dir) => (lookups++, diskHost.dirents(dir)) }
      const resolution = resolutionOf({ host, assetExts: [] })
      const resolve = (changes) => resolution(changes, new Set())(join(root, 'index.js'), './a', { platform: 'ios', isESMImport: true })
      assert.equal(resolve(null)?.filePath, join(root, 'a.js'))
      const looked = lookups
      assert.ok(looked > 0)
      assert.equal(resolve([{ path: join(root, 'a.js'), event: 'change' }])?.filePath, join(root, 'a.js'))
      assert.equal(lookups, looked)
      assert.equal(resolve(null)?.filePath, join(root, 'a.js'))
      assert.ok(lookups > looked)
      // a.ios.js, which the resolver looked for, made: resolved anew, to it.
      writeFileSync(join(root, 'a.ios.js'), '')
      assert.equal(resolve([{ path: join(root, 'a.ios.js'), event: 'rename' }])?.filePath, join(root, 'a.ios.js'))
    } finally {
      cleanup()
    }
  })
})

describe('a dev bundler, of watcher-caused builds', () => {
  const { root, cleanup } = writeTree({
    'index.js': "import { a } from './a'\nglobalThis.result = a\n",
    'a.js': "export const a = 'one'\n",
  })
  after(cleanup)
  const runtime = createRequire(import.meta.url).resolve('metro-runtime/src/polyfills/require.js')
  const request = { kind: 'bundle', entryFile: './index', platform: 'ios', dev: true, minify: false }

  it("reads only the files the watcher saw change, resolving only what may change, its result as a full build's; and, of a reload's (changed() of no path), resolves and reads each anew", async () => {
    const reads = []
    let lookups = 0
    const host = {
      ...diskHost,
      readFile: (path) => {
        if (path.startsWith(root)) reads.push(relative(root, path))
        return diskHost.readFile(path)
      },
      dirents: (dir) => (lookups++, diskHost.dirents(dir)),
    }
    const devBundler = createDevBundler({ projectRoot: root, esbuild, runtime, host, targetOptions: () => ({ define: {} }) })
    // A build of the bundle: the project's files it read, whether it listed any directory, and its result.
    const built = async () => {
      reads.length = 0
      lookups = 0
      const outcome = await devBundler.get(request)
      const context = createContext({})
      runInContext(outcome.js, context)
      return [reads.toSorted(), lookups > 0, context.result]
    }
    const changed = (path, event) => devBundler.changed(join(root, path), event)
    try {
      assert.deepEqual(await built(), [['a.js', 'index.js'], true, 'one'])
      writeFileSync(join(root, 'a.js'), "export const a = 'two'\n")
      changed('a.js', 'change')
      assert.deepEqual(await built(), [['a.js'], false, 'two'])
      // A file added, and imported: it resolves, its directory listed anew.
      writeFileSync(join(root, 'b.js'), "export const b = 'b'\n")
      writeFileSync(join(root, 'a.js'), "import { b } from './b'\nexport const a = 'three ' + b\n")
      changed('b.js', 'rename')
      changed('a.js', 'change')
      assert.deepEqual(await built(), [['a.js', 'b.js'], true, 'three b'])
      // A file kept in memory, imported no more, then changed, then imported again: read again, as changed.
      writeFileSync(join(root, 'a.js'), "export const a = 'four'\n")
      changed('a.js', 'change')
      assert.deepEqual(await built(), [['a.js'], false, 'four'])
      writeFileSync(join(root, 'b.js'), "export const b = 'b2'\n")
      changed('b.js', 'change')
      assert.deepEqual(await built(), [[], false, 'four'])
      writeFileSync(join(root, 'a.js'), "import { b } from './b'\nexport const a = 'five ' + b\n")
      changed('a.js', 'change')
      assert.deepEqual(await built(), [['a.js', 'b.js'], false, 'five b2'])
      devBundler.changed()
      assert.deepEqual(await built(), [['a.js', 'b.js', 'index.js'], true, 'five b2'])
    } finally {
      await devBundler.dispose()
    }
  })
})

describe('a dev server, of /reload', () => {
  it('builds each bundle anew after it, not as the watcher\'s changes leave the build before, as `r` does', async () => {
    const calls = []
    const devBundler = { changed: (...args) => calls.push(args) }
    const { server } = createDevServer({ projectRoot: process.cwd(), esbuild, devBundler, gate: () => null })
    await new Promise((done) => {
      server.listen(0, '127.0.0.1', done)
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/reload`)
      assert.deepEqual([response.status, await response.text(), calls], [200, 'OK', [[]]])
    } finally {
      server.close()
    }
  })
})

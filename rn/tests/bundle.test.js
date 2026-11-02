import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { bundle, createBundler, newState } from '../src/bundle.js'
import { listing, lookingOnce } from '../src/build-host.js'
import { diskHost } from '../src/defaults.js'
import { png, vfsOf, writeTree } from './fixtures.js'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const core = require('@babel/core')

const APP = {
  'package.json': { name: 'app' },
  'index.js': "import { value } from './lib/value'\nimport { typed, fail } from './lib/typed'\nimport dep from 'dep'\nglobalThis.result = [value, typed, dep]\nglobalThis.fail = fail\n",
  // Resolved by its manifest's main.
  'node_modules/dep/package.json': { name: 'dep', main: 'lib/main.js' },
  'node_modules/dep/lib/main.js': "module.exports = 'dep'\n",
  'lib/value.js': 'export const value = 1\n',
  'lib/typed.ts': "type T = number\n\nexport const typed: T = 2\nexport function fail(): never {\n  throw new Error('typed')\n}\n",
}

// The bundle run in a context of its own. -> its globalThis.result.
const run = (code) => {
  const context = {}
  context.globalThis = context
  runInNewContext(code, context)
  return JSON.parse(JSON.stringify(context.result))
}
const js = (result) => result.outputFiles.find(({ path }) => path.endsWith('.js')).text

describe('bundle', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const options = { entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root }
  const files = (...names) => names.map((name) => join(root, name)).toSorted()

  it('builds again and again on one context, each build reading the files anew, and says which it read, manifests too', async () => {
    const bundler = await createBundler(options)
    try {
      const first = await bundler.rebuild()
      assert.deepEqual(run(js(first)), [1, 2, 'dep'])
      for (const file of files('index.js', 'lib/typed.ts', 'lib/value.js', 'node_modules/dep/lib/main.js', 'node_modules/dep/package.json', 'package.json')) assert.ok(first.files.includes(file), file)
      writeFileSync(join(root, 'lib/value.js'), 'export const value = 3\n')
      assert.deepEqual(run(js(await bundler.rebuild())), [3, 2, 'dep'])
      // A manifest edited: what it resolves to changes.
      writeFileSync(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', main: 'lib/other.js' }))
      writeFileSync(join(root, 'node_modules/dep/lib/other.js'), "module.exports = 'other'\n")
      assert.deepEqual(run(js(await bundler.rebuild())), [3, 2, 'other'])
      writeFileSync(join(root, 'lib/value.js'), 'export const value = (\n')
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.ok(error.files.includes(join(root, 'lib/value.js')))
    } finally {
      writeFileSync(join(root, 'lib/value.js'), APP['lib/value.js'])
      writeFileSync(join(root, 'node_modules/dep/package.json'), JSON.stringify(APP['node_modules/dep/package.json']))
      await bundler.dispose()
    }
  })

  it('reads the manifests anew for its first build too, whenever that is', async () => {
    const bundler = await createBundler(options)
    try {
      // The root manifest, which finding what runs before the entry reads, now redirects dep.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', 'react-native': { dep: './lib/shim.js' } }))
      writeFileSync(join(root, 'lib/shim.js'), "module.exports = 'shim'\n")
      assert.deepEqual(run(js(await bundler.rebuild())), [1, 2, 'shim'])
    } finally {
      writeFileSync(join(root, 'package.json'), JSON.stringify(APP['package.json']))
      await bundler.dispose()
    }
  })

  it("keeps each file's transform in the cache while its contents are the same", async () => {
    const transformed = []
    const babel = (code, path) => {
      transformed.push(basename(path))
      return code
    }
    const bundler = await createBundler({ ...options, babel, cache: new Map() })
    try {
      await bundler.rebuild()
      await bundler.rebuild()
      assert.deepEqual(transformed.toSorted(), ['index.js', 'main.js', 'typed.ts', 'value.js'])
      writeFileSync(join(root, 'lib/value.js'), 'export const value = 4\n')
      assert.deepEqual(run(js(await bundler.rebuild())), [4, 2, 'dep'])
      assert.deepEqual(transformed.toSorted(), ['index.js', 'main.js', 'typed.ts', 'value.js', 'value.js'])
    } finally {
      writeFileSync(join(root, 'lib/value.js'), APP['lib/value.js'])
      await bundler.dispose()
    }
  })

  it('reads ahead each file it resolves, off the main thread, and loads it of what it read; else, failing, as the host reads it', async () => {
    const ahead = []
    const readFileAsync = (path) => {
      ahead.push(basename(path))
      return Promise.resolve(path.endsWith('value.js') ? Buffer.from('export const value = 5\n') : diskHost.readFile(path))
    }
    const result = await bundle({ ...options, host: { ...diskHost, readFileAsync } })
    assert.deepEqual(run(js(result)), [5, 2, 'dep'])
    assert.deepEqual(ahead.toSorted(), ['index.js', 'main.js', 'typed.ts', 'value.js'])
    for (const file of files('index.js', 'lib/typed.ts', 'lib/value.js', 'node_modules/dep/lib/main.js')) assert.ok(result.files.includes(file), file)
    const failing = await bundle({ ...options, host: { ...diskHost, readFileAsync: () => Promise.reject(new Error('EIO')) } })
    assert.deepEqual(run(js(failing)), [1, 2, 'dep'])
    assert.ok(failing.files.includes(join(root, 'lib/value.js')))
  })

  it("maps the bundle to each source, through esbuild's lowering and Babel's transform", async () => {
    const babel = async (code, filename) => (await core.transformAsync(code, { filename, babelrc: false, configFile: false, sourceMaps: 'inline' })).code
    for (const transform of [null, babel]) {
      const result = await bundle({ ...options, babel: transform, sourcemap: true })
      const lines = js(result).split('\n')
      const line = lines.findIndex((text) => text.includes('throw new Error('))
      const map = new SourceMap(JSON.parse(result.outputFiles.find(({ path }) => path.endsWith('.map')).text))
      const { originalSource, originalLine, originalColumn } = map.findEntry(line, lines[line].indexOf('throw'))
      assert.deepEqual([basename(originalSource), originalLine + 1, originalColumn], ['typed.ts', 5, 2], transform === null ? 'esbuild' : 'Babel')
    }
  })
})

describe('bundle, of an asset it cannot build', () => {
  const { root, cleanup } = writeTree({
    'index.js': "const { getAssetByID } = require('react-native/Libraries/Image/AssetRegistry')\nglobalThis.result = [require('./img/logo.png'), require('./img/icon.png')].map((id) => getAssetByID(id).width)\n",
    'img/logo.png': '',
    // iOS's own file of the asset, which only building it reads.
    'img/icon.png': png(8, 8),
    'img/icon.ios.png': '',
    'node_modules/react-native/Libraries/Image/AssetRegistry.js': 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n',
  })
  after(cleanup)

  it('says it read the asset, so that a watcher sees it fixed', async () => {
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.match(error?.errors?.[0]?.text ?? '', /cannot be an empty file/u)
      for (const file of ['img/logo.png', 'img/icon.ios.png']) assert.ok(error.files.includes(join(root, file)), `${file} in ${error.files}`)
      writeFileSync(join(root, 'img/logo.png'), png(20, 10))
      writeFileSync(join(root, 'img/icon.ios.png'), png(9, 9))
      assert.deepEqual(run(js(await bundler.rebuild())), [20, 9])
    } finally {
      await bundler.dispose()
    }
  })
})

describe('bundle, of a manifest that is no JSON', () => {
  const { root, cleanup } = writeTree({ 'package.json': '{', 'index.js': 'globalThis.result = 1\n' })
  after(cleanup)

  it('fails the build, not the bundler, and says it read it, so that a watcher sees it fixed', async () => {
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.ok(error.files.includes(join(root, 'package.json')), String(error.files))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
      assert.equal(run(js(await bundler.rebuild())), 1)
    } finally {
      await bundler.dispose()
    }
  })
})

describe('bundle, of an import written before its module', () => {
  const { root, cleanup } = writeTree({ 'index.js': "globalThis.result = require('./src/later')\n", 'src/other.txt': '' })
  after(cleanup)

  it('says it looked for it, so that a watcher sees it made', async () => {
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.match(error?.errors?.[0]?.text ?? '', /Could not resolve "\.\/src\/later"/u)
      assert.ok(error.files.includes(join(root, 'src/later.js')), String(error.files))
      writeFileSync(join(root, 'src/later.js'), "module.exports = 'later'\n")
      assert.equal(run(js(await bundler.rebuild())), 'later')
    } finally {
      await bundler.dispose()
    }
  })
})

describe('bundle, of an entry not there', () => {
  const { root, cleanup } = writeTree({ 'src/other.txt': '' })
  after(cleanup)

  it('says it looked for it, so that a watcher sees it made', async () => {
    const bundler = await createBundler({ entry: 'src/index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.ok(error.files.includes(join(root, 'src/index.js')), String(error.files))
      writeFileSync(join(root, 'src/index.js'), 'globalThis.result = 1\n')
      assert.equal(run(js(await bundler.rebuild())), 1)
    } finally {
      await bundler.dispose()
    }
  })
})

describe("lookingOnce, a build's host", () => {
  it('asks the host of each path once: a file, a directory, a real path', () => {
    const asked = []
    const host = { isFile: (path) => asked.push(['isFile', path]) > 0 && path.endsWith('.js'), isDirectory: (path) => asked.push(['isDirectory', path]) > 0 && !path.endsWith('.js'), realpath: (path) => asked.push(['realpath', path]) && path, readFile: () => '' }
    const once = lookingOnce(host)
    for (let i = 0; i < 2; i++) assert.deepEqual([once.isFile('/a.js'), once.isFile('/b'), once.isDirectory('/b'), once.realpath('/a.js')], [true, false, true, '/a.js'])
    assert.deepEqual(asked, [['isFile', '/a.js'], ['isFile', '/b'], ['isDirectory', '/b'], ['realpath', '/a.js']])
  })
})

describe("listing, a build's host", () => {
  const { root, cleanup } = writeTree({
    'src/a.js': '',
    'src/b.ios.js': '',
    'src/dir/index.js': '',
    'linked.js': { link: 'src/a.js' },
    'linked-dir': { link: 'src/dir' },
  })
  after(cleanup)

  it("answers whether a path is a file or a directory as its directory lists it, a link as the host has it", () => {
    const host = listing(diskHost)
    const paths = ['src/a.js', 'src/b.ios.js', 'src/b.js', 'src/dir', 'src/dir/index.js', 'src/nothing/a.js', 'linked.js', 'linked-dir', 'linked-dir/index.js', 'src/a.js/x', 'src']
    for (const path of paths.map((name) => join(root, name))) {
      assert.deepEqual([host.isFile(path), host.isDirectory(path)], [diskHost.isFile(path), diskHost.isDirectory(path)], path)
    }
    // Of its names as they are, as Metro's file map has them.
    assert.equal(host.isFile(join(root, 'src/A.js')), false)
    assert.equal(host.isDirectory('/'), true)
  })

  it('lists each directory once, and leaves a host that lists none as it is', () => {
    const listed = []
    const host = listing({ ...diskHost, dirents: (dir) => listed.push(dir) && diskHost.dirents(dir) })
    for (const name of ['a.js', 'b.ios.js', 'b.native.js', 'b.js', 'dir']) host.isFile(join(root, 'src', name))
    assert.deepEqual(listed, [join(root, 'src')])
    const plain = { isFile: () => true, isDirectory: () => false }
    assert.equal(listing(plain), plain)
    // A directory not to be listed, but searched (EACCES, of mode 0111):
    // each path in it as the host has it. One not there: nothing in it.
    const asked = []
    const failing = (code) => () => {
      throw Object.assign(new Error(code), { code })
    }
    const locked = listing({ isFile: (path) => asked.push(path) > 0 && path === '/locked/a.js', isDirectory: () => false, dirents: failing('EACCES') })
    assert.deepEqual([locked.isFile('/locked/a.js'), locked.isFile('/locked/b.js'), asked], [true, false, ['/locked/a.js', '/locked/b.js']])
    for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(listing({ isFile: () => true, isDirectory: () => true, dirents: failing(code) }).isFile('/gone/a.js'), false, code)
    // @preventive/vfs's, whose `entries` are an archive's, not a directory's.
    const vfs = vfsOf({ 'index.js': '', 'lib/a.js': '' })
    assert.equal(listing(vfs), vfs)
    let state = null
    newState({ host: vfs, assetExts: [], projectRoot: '/', entry: 'index.js', platform: 'ios' }, (made) => (state = made))
    assert.deepEqual(state.resolveModule('/index.js', './lib/a', { platform: 'ios' }), { type: 'sourceFile', filePath: '/lib/a.js' })
  })
})

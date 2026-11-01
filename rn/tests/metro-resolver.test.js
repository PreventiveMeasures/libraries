import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { relative } from 'node:path'
import { after, describe, it } from 'node:test'

import { createMetroResolver, defaults } from '../metro-resolver.js'
import { TREE, requestsIn } from './metro-tree.js'
import { png, shown, vfsOf, writeTree } from './fixtures.js'

const metroResolver = createRequire(import.meta.url)('metro-resolver')

describe('createMetroResolver over a Vfs', () => {
  const { root, cleanup } = writeTree(TREE)
  after(cleanup)

  // Every case as the built-in resolver answers it on disk.
  const differences = (memory) => {
    const disk = createMetroResolver()
    return requestsIn(root)
      .map(([origin, specifier, options]) => [specifier, options, shown(root, disk(origin, specifier, options)), shown('/', memory(`/${relative(root, origin)}`, specifier, options))])
      .filter(([, , a, b]) => a !== b)
  }

  it('resolves every case as it does on disk', () => assert.deepEqual(differences(createMetroResolver({ host: vfsOf(TREE) })), []))
  it('resolves every case through metro-resolver too', () => assert.deepEqual(differences(createMetroResolver({ host: vfsOf(TREE), metroResolver })), []))

  it('answers by real paths, through a link', () => {
    const resolve = createMetroResolver({ host: vfsOf(TREE) })
    assert.deepEqual(resolve('/index.js', 'linked'), { type: 'sourceFile', filePath: '/node_modules/.pnpm/linked@1.0.0/node_modules/linked/lib/browser.js' })
  })
})

describe('createMetroResolver', () => {
  it('answers Metro\'s Resolution shapes', () => {
    const resolve = createMetroResolver({ host: vfsOf({ 'a.js': '', 'b.png': png(1, 1), 'b@2x.png': png(2, 2), 'package.json': { browser: { gone: false } } }) })
    assert.deepEqual(resolve('/index.js', './a'), { type: 'sourceFile', filePath: '/a.js' })
    assert.deepEqual(resolve('/index.js', './b.png'), { type: 'assetFiles', filePaths: ['/b.png', '/b@2x.png'] })
    assert.deepEqual(resolve('/index.js', 'gone'), { type: 'empty' })
    assert.equal(resolve('/index.js', './c'), null)
  })

  it('finds an asset\'s files at each scale given, by real paths, and no directory', () => {
    const host = vfsOf({ 'img/a.png': '', 'img/a@3x.png': '', 'img/b@2x.png': '', 'img/c.png/index.js': '', 'img/d.png': { link: 'a.png' } })
    const files = (specifier, options) => createMetroResolver({ host, ...options })('/x.js', specifier)?.filePaths ?? null
    assert.deepEqual(files('./img/a.png'), ['/img/a.png', '/img/a@3x.png'])
    assert.deepEqual(files('./img/b.png'), ['/img/b@2x.png'])
    assert.deepEqual(files('./img/d.png'), ['/img/a.png'])
    assert.equal(files('./img/b.png', { assetResolutions: ['1', '3'] }), null)
    assert.equal(files('./img/c.png'), null)
  })

  it('takes the platform and the kind of import per request', () => {
    const resolve = createMetroResolver({ host: vfsOf({ 'a.ios.js': '', 'a.js': '', 'node_modules/c/package.json': { exports: { import: './esm.js', default: './cjs.js' } }, 'node_modules/c/esm.js': '', 'node_modules/c/cjs.js': '' }) })
    assert.equal(resolve('/x.js', './a').filePath, '/a.js')
    assert.equal(resolve('/x.js', './a', { platform: 'ios' }).filePath, '/a.ios.js')
    assert.equal(resolve('/x.js', 'c').filePath, '/node_modules/c/cjs.js')
    assert.equal(resolve('/x.js', 'c', { isESMImport: true }).filePath, '/node_modules/c/esm.js')
  })

  it('reads each package.json once', () => {
    const vfs = vfsOf({ 'package.json': { name: 'app', browser: {} }, 'src/a.js': '', 'src/b.js': '' })
    const reads = []
    const counting = { isFile: (p) => vfs.isFile(p), isDirectory: (p) => vfs.isDirectory(p), realpath: (p) => vfs.realpath(p), readdir: (p) => vfs.readdir(p), readFile: (p) => (reads.push(p), vfs.readFile(p)) }
    const resolve = createMetroResolver({ host: counting })
    for (const specifier of ['./a', './b', './a.js', 'missing']) resolve('/src/index.js', specifier)
    assert.deepEqual(reads, ['/package.json'])
  })

  for (const via of [{}, { metroResolver }]) {
    it(`throws on a package.json that is no JSON object, as Metro does${via.metroResolver ? ', through metro-resolver' : ''}`, () => {
      const resolving = (manifest) => () => createMetroResolver({ host: vfsOf({ 'package.json': manifest, 'a.js': '' }), ...via })('/x.js', './a')
      assert.throws(resolving('{'), /Invalid package\.json: \/package\.json/u)
      assert.throws(resolving('[]'), /not an object/u)
      assert.throws(resolving('\uFEFF{}'), /Invalid package\.json/u)
    })
  }

  it('answers null where metro-resolver fails, and throws the host\'s errors', () => {
    const vfs = vfsOf({ 'a.js': '' })
    assert.equal(createMetroResolver({ host: vfs, metroResolver })('/x.js', './b'), null)
    const broken = { isFile: () => true, isDirectory: () => false, realpath: () => { throw new Error('gone') }, readFile: (p) => vfs.readFile(p), readdir: () => [] }
    assert.throws(() => createMetroResolver({ host: broken, metroResolver })('/x.js', './a'), /gone/u)
  })

  it('refuses what it cannot resolve from', () => {
    const resolve = createMetroResolver({ host: vfsOf({}) })
    assert.throws(() => resolve('x.js', './a'), TypeError)
    assert.throws(() => resolve('/x.js', 5), TypeError)
    assert.throws(() => createMetroResolver({ nodeModulesPaths: ['node_modules'] }), TypeError)
    assert.throws(() => createMetroResolver({ extraNodeModules: { a: 'shims/a' } }), TypeError)
    assert.throws(() => createMetroResolver({ metroResolver: {} }), TypeError)
  })

  it('takes its options as they were when made', () => {
    const conditionNames = ['react-native']
    const resolve = createMetroResolver({ host: vfsOf({ 'node_modules/c/package.json': { exports: { 'react-native': './rn.js', default: './d.js' } }, 'node_modules/c/rn.js': '', 'node_modules/c/d.js': '' }), conditionNames })
    conditionNames.pop()
    assert.equal(resolve('/x.js', 'c').filePath, '/node_modules/c/rn.js')
  })

  it('has React Native\'s defaults, frozen', () => {
    assert.deepEqual(defaults.mainFields, ['react-native', 'browser', 'main'])
    assert.deepEqual(defaults.conditionNames, ['react-native'])
    assert.deepEqual(defaults.conditionsByPlatform, { web: ['browser'] })
    assert.deepEqual(defaults.sourceExts, ['js', 'jsx', 'json', 'ts', 'tsx'])
    assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.assetExts) && Object.isFrozen(defaults.conditionsByPlatform.web))
  })
})

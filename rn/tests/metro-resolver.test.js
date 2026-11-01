import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createVfs } from '@preventive/vfs'

import { createMetroResolver, defaults, resolveAsset } from '../metro-resolver.js'
import { CASES, TREE } from './metro-tree.js'
import { png, shown, writeTree } from './fixtures.js'

// The tree as a Vfs holds it, from `/`.
const vfsOf = (tree) => createVfs(Object.fromEntries(Object.entries(tree).map(([rel, content]) => {
  if (content !== null && typeof content === 'object' && 'link' in content) return [rel, { type: 'symlink', target: content.link }]
  return [rel, typeof content === 'string' || content instanceof Uint8Array ? content : JSON.stringify(content)]
})))

describe('createMetroResolver over a Vfs', () => {
  const { root, cleanup } = writeTree(TREE)
  after(cleanup)

  it('resolves every case as it does on disk', () => {
    const disk = createMetroResolver()
    const memory = createMetroResolver({ host: vfsOf(TREE) })
    const differ = []
    for (const platform of [null, 'ios', 'android', 'web']) {
      for (const [from, specifiers] of CASES) {
        for (const specifier of specifiers) {
          const [a, b] = [shown(root, disk(join(root, from), specifier, { platform })), shown('/', memory(join('/', from), specifier, { platform }))]
          if (a !== b) differ.push(`${platform} ${specifier} from ${from}: disk ${a}, vfs ${b}`)
        }
      }
    }
    assert.deepEqual(differ, [])
  })

  it('answers by real paths, through a link', () => {
    const resolve = createMetroResolver({ host: vfsOf(TREE) })
    assert.deepEqual(resolve('/index.js', 'linked'), { type: 'sourceFile', filePath: '/node_modules/.pnpm/linked@1.0.0/node_modules/linked/lib/browser.js' })
  })
})

describe('createMetroResolver', () => {
  const host = (tree) => vfsOf(tree)

  it('answers Metro\'s Resolution shapes', () => {
    const resolve = createMetroResolver({ host: host({ 'a.js': '', 'b.png': png(1, 1), 'b@2x.png': png(2, 2), 'package.json': { browser: { gone: false } } }) })
    assert.deepEqual(resolve('/index.js', './a'), { type: 'sourceFile', filePath: '/a.js' })
    assert.deepEqual(resolve('/index.js', './b.png'), { type: 'assetFiles', filePaths: ['/b.png', '/b@2x.png'] })
    assert.deepEqual(resolve('/index.js', 'gone'), { type: 'empty' })
    assert.equal(resolve('/index.js', './c'), null)
  })

  it('takes the platform and the kind of import per request', () => {
    const resolve = createMetroResolver({ host: host({ 'a.ios.js': '', 'a.js': '', ...{ 'node_modules/c/package.json': { exports: { import: './esm.js', default: './cjs.js' } }, 'node_modules/c/esm.js': '', 'node_modules/c/cjs.js': '' } }) })
    assert.equal(resolve('/x.js', './a').filePath, '/a.js')
    assert.equal(resolve('/x.js', './a', { platform: 'ios' }).filePath, '/a.ios.js')
    assert.equal(resolve('/x.js', 'c').filePath, '/node_modules/c/cjs.js')
    assert.equal(resolve('/x.js', 'c', { isESMImport: true }).filePath, '/node_modules/c/esm.js')
  })

  it('reads each package.json once', () => {
    const vfs = host({ 'package.json': { name: 'app', browser: {} }, 'src/a.js': '', 'src/b.js': '' })
    const reads = []
    const counting = { isFile: (p) => vfs.isFile(p), isDirectory: (p) => vfs.isDirectory(p), realpath: (p) => vfs.realpath(p), readdir: (p) => vfs.readdir(p), readFile: (p) => (reads.push(p), vfs.readFile(p)) }
    const resolve = createMetroResolver({ host: counting })
    for (const specifier of ['./a', './b', './a.js', 'missing']) resolve('/src/index.js', specifier)
    assert.deepEqual(reads, ['/package.json'])
  })

  it('throws on a package.json that is no JSON object, as Metro does', () => {
    assert.throws(() => createMetroResolver({ host: host({ 'package.json': '{', 'a.js': '' }) })('/x.js', './a'), /Invalid package\.json: \/package\.json/u)
    assert.throws(() => createMetroResolver({ host: host({ 'package.json': '[]', 'a.js': '' }) })('/x.js', './a'), /not an object/u)
    assert.throws(() => createMetroResolver({ host: host({ 'package.json': '﻿{}', 'a.js': '' }) })('/x.js', './a'), /Invalid package\.json/u)
  })

  it('refuses what it cannot resolve from', () => {
    const resolve = createMetroResolver({ host: host({}) })
    assert.throws(() => resolve('x.js', './a'), TypeError)
    assert.throws(() => resolve('/x.js', 5), TypeError)
    assert.throws(() => createMetroResolver({ nodeModulesPaths: ['node_modules'] }), TypeError)
    assert.throws(() => createMetroResolver({ extraNodeModules: { a: 'shims/a' } }), TypeError)
  })

  it('has React Native\'s defaults, frozen', () => {
    assert.deepEqual(defaults.mainFields, ['react-native', 'browser', 'main'])
    assert.deepEqual(defaults.conditionNames, ['react-native'])
    assert.deepEqual(defaults.conditionsByPlatform, { web: ['browser'] })
    assert.deepEqual(defaults.sourceExts, ['js', 'jsx', 'json', 'ts', 'tsx'])
    assert.ok(Object.isFrozen(defaults) && Object.isFrozen(defaults.assetExts) && Object.isFrozen(defaults.conditionsByPlatform.web))
  })
})

describe('resolveAsset', () => {
  const vfs = vfsOf({ 'img/a.png': '', 'img/a@3x.png': '', 'img/b@2x.png': '', 'img/c.png/index.js': '', 'img/d.png': { link: 'a.png' } })

  it('finds an asset\'s files at each scale, by real paths', () => {
    assert.deepEqual(resolveAsset('/img', 'a', '.png', { host: vfs }), ['/img/a.png', '/img/a@3x.png'])
    assert.deepEqual(resolveAsset('/img', 'b', '.png', { host: vfs }), ['/img/b@2x.png'])
    assert.deepEqual(resolveAsset('/img', 'd', '.png', { host: vfs }), ['/img/a.png'])
    assert.deepEqual(resolveAsset('/img', 'b', '.png', { host: vfs, assetResolutions: ['1', '3'] }), null)
  })

  it('takes no directory for an asset', () => {
    assert.equal(resolveAsset('/img', 'c', '.png', { host: vfs }), null)
  })
})

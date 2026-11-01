import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { assetData, assetModule, assetRecord, isAssetFile } from '../metro-assets.js'
import { parseAssetPath } from '../src/assets.js'
import { imageDimensions, isAssetTypeAnImage } from '../src/image-size.js'
import { png, vfsOf, writeTree } from './fixtures.js'

describe('parseAssetPath', () => {
  // [path, platform, expected], as Metro's AssetPaths.tryParse reads them.
  const CASES = [
    ['img/logo.png', null, { assetName: 'img/logo.png', name: 'logo', platform: null, resolution: 1, type: 'png' }],
    ['img/logo@2x.png', null, { assetName: 'img/logo.png', name: 'logo', platform: null, resolution: 2, type: 'png' }],
    ['logo@1.5x.ios.png', 'ios', { assetName: 'logo.png', name: 'logo', platform: 'ios', resolution: 1.5, type: 'png' }],
    ['logo@1.5x.ios.png', 'android', { assetName: 'logo@1.5x.ios.png', name: 'logo@1.5x.ios', platform: null, resolution: 1, type: 'png' }],
    ['logo.ios@2x.png', 'ios', { assetName: 'logo.ios.png', name: 'logo.ios', platform: null, resolution: 2, type: 'png' }],
    ['logo@x.png', null, { assetName: 'logo@x.png', name: 'logo@x', platform: null, resolution: 1, type: 'png' }],
    ['logo@..x.png', null, { assetName: 'logo.png', name: 'logo', platform: null, resolution: 1, type: 'png' }],
    ['a.tar.gz', null, { assetName: 'a.tar.gz', name: 'a.tar', platform: null, resolution: 1, type: 'gz' }],
    ['logo', null, null],
    ['.png', null, null],
  ]
  for (const [path, platform, expected] of CASES) {
    it(`reads ${path} for ${platform}`, () => assert.deepEqual(parseAssetPath(path, platform), expected))
  }
})

describe('isAssetFile', () => {
  it('takes any dot-suffix of the name', () => {
    assert.ok(isAssetFile('/a/b.png'))
    assert.ok(isAssetFile('/a/b.tar.gz', ['tar.gz']))
    assert.ok(isAssetFile('/a/b.tar.gz', new Set(['gz'])))
    assert.ok(!isAssetFile('/a.png/b.js'))
    assert.ok(!isAssetFile('/a/png'))
  })
})

describe('imageDimensions', () => {
  const bytes = (hex, ...rest) => Buffer.concat([Buffer.from(hex, 'hex'), ...rest])
  // [type, bytes, width, height]
  const IMAGES = [
    ['png', png(16, 32)],
    // Apple's CgBI PNG, its IHDR after the CgBI chunk.
    ['png', bytes('89504e470d0a1a0a000000044367424950002006000000000000000d494844520000001000000020', Buffer.alloc(8))],
    ['gif', bytes('474946383961100020000000')],
    ['bmp', bytes('424d', Buffer.alloc(12), Buffer.from('28000000', 'hex'), Buffer.from('10000000e0ffffff', 'hex'), Buffer.alloc(8))],
    ['jpg', bytes('ffd8ffe000104a46494600010100000100010000ffc0001108002000100301220002110103110100')],
    ['webp', bytes('52494646000000005745425056503858', Buffer.from('0a000000000000000f00001f0000', 'hex'))],
    ['tiff', bytes('49492a00080000000200000103000100000010000000010104000100000020000000')],
    ['tiff', bytes('4d4d002a00000008000201000003000000010010000001010004000000010000002000')],
    ['psd', bytes('3842505300010000000000000000000000200000001000000000')],
    ['ktx', bytes('ab4b5458203131bb0d0a1a0a01020304', Buffer.alloc(20), Buffer.from('1000000020000000', 'hex'), Buffer.alloc(20))],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" data-width="5" width="16px" height=\'32\'>')],
  ]
  for (const [type, content] of IMAGES) {
    it(`reads a ${type}`, () => assert.deepEqual(imageDimensions(type, new Uint8Array(content), 'f'), { width: 16, height: 32 }))
  }

  it('reads an svg in its units, and by its viewBox', () => {
    assert.deepEqual(imageDimensions('svg', Buffer.from('<svg width="1in" viewBox="0 0 30 15">'), 'f'), { width: 96, height: 48 })
    assert.deepEqual(imageDimensions('svg', Buffer.from('<svg viewBox="0,0,40.5,20">'), 'f'), { width: 40.5, height: 20 })
  })

  it('reads an image by what it holds where its type says otherwise', () => {
    assert.deepEqual(imageDimensions('jpg', png(3, 4), 'f'), { width: 3, height: 4 })
  })

  it('throws for what no parser reads, or a size of nothing', () => {
    assert.throws(() => imageDimensions('png', Buffer.from('not an image'), 'img/x.png'), { message: 'Invalid png image asset: img/x.png' })
    assert.throws(() => imageDimensions('png', png(0, 4), 'f'), /Invalid png/u)
  })

  it('knows Metro\'s image types', () => {
    for (const type of ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'psd', 'svg', 'tiff', 'ktx']) assert.ok(isAssetTypeAnImage(type), type)
    for (const type of ['xml', 'mp4', 'ttf', 'heic']) assert.ok(!isAssetTypeAnImage(type), type)
  })
})

describe('assetRecord and assetData', () => {
  const TREE = {
    'img/logo.png': png(10, 20),
    'img/logo@2x.png': png(20, 40),
    'img/logo@3x.png': png(30, 60),
    'img/logo.ios.png': png(11, 21),
    'img/logo@3x.ios.png': png(33, 63),
    'img/logo.android.png': png(1, 1),
    'img/other.png': png(1, 1),
    'img/font.ttf': 'font',
    'img/font@2x.ttf': 'font2',
    'img/b@2x.png': png(4, 4),
    'img/b@2.0x.png': png(4, 4),
    'img/empty.png': '',
  }
  const { root, cleanup } = writeTree(TREE)
  after(cleanup)
  const md5 = (...files) => {
    const hash = createHash('md5')
    for (const file of files) hash.update(TREE[file])
    return hash.digest('hex')
  }

  it('lists an asset\'s files by scale, the platform\'s where it has any', () => {
    const at = (name) => join(root, 'img', name)
    assert.deepEqual(assetRecord(at('logo.png')), { files: [at('logo.png'), at('logo@2x.png'), at('logo@3x.png')], scales: [1, 2, 3] })
    assert.deepEqual(assetRecord(at('logo.png'), { platform: 'ios' }), { files: [at('logo.ios.png'), at('logo@3x.ios.png')], scales: [1, 3] })
    assert.deepEqual(assetRecord(at('logo.png'), { platform: 'web' }), { files: [at('logo.png'), at('logo@2x.png'), at('logo@3x.png')], scales: [1, 2, 3] })
    // Ties at one scale in the order libuv lists their names.
    assert.deepEqual(assetRecord(at('b.png')).files, [at('b@2.0x.png'), at('b@2x.png')])
    assert.throws(() => assetRecord(at('none.png')), { message: `Asset not found: ${at('none.png')} for platform: (unspecified)` })
  })

  it('builds Metro\'s data of an asset', () => {
    const data = assetData(join(root, 'img/logo.png'), { urlPath: 'img/logo.png', platform: 'ios' })
    assert.deepEqual(data, {
      __packager_asset: true,
      fileSystemLocation: join(root, 'img'),
      httpServerLocation: '/assets/img',
      width: 11,
      height: 21,
      scales: [1, 3],
      files: [join(root, 'img/logo.ios.png'), join(root, 'img/logo@3x.ios.png')],
      hash: md5('img/logo.ios.png', 'img/logo@3x.ios.png'),
      name: 'logo',
      type: 'png',
    })
  })

  it('sizes an image by its first file over its scale, and none but an image', () => {
    const b = assetData(join(root, 'img/b.png'), { urlPath: 'img/b.png' })
    assert.deepEqual([b.width, b.height, b.scales], [2, 2, [2, 2]])
    const font = assetData(join(root, 'img/font.ttf'), { urlPath: 'img/font.ttf' })
    assert.deepEqual([font.width, font.height, font.hash], [undefined, undefined, md5('img/font.ttf', 'img/font@2x.ttf')])
    assert.throws(() => assetData(join(root, 'img/empty.png'), { urlPath: 'img/empty.png' }), /cannot be an empty file/u)
  })

  it('places an asset under publicPath, one above the root by its `..`', () => {
    const location = (urlPath, publicPath) => assetData(join(root, 'img/other.png'), { urlPath, publicPath }).httpServerLocation
    assert.equal(location('other.png'), '/assets')
    assert.equal(location('a/b/other.png', '/static/'), '/static/a/b')
    assert.equal(location('../up/other.png', '/assets/'), '/assets/../up')
    assert.throws(() => assetData(join(root, 'img/other.png'), {}), TypeError)
  })

  it('reads a tree through a host', () => {
    const vfs = vfsOf({ 'a/x.png': png(2, 2), 'a/x@2x.png': png(4, 4) })
    const data = assetData('/a/x.png', { urlPath: 'a/x.png', host: vfs })
    assert.deepEqual([data.files, data.width], [['/a/x.png', '/a/x@2x.png'], 2])
  })
})

describe('assetModule', () => {
  it('registers the asset\'s data less its files', () => {
    const data = { __packager_asset: true, fileSystemLocation: '/p/img', httpServerLocation: '/assets/img', width: 10, height: undefined, scales: [1, 2], files: ['/p/img/a.png'], hash: 'h', name: 'a', type: 'png' }
    assert.equal(
      assetModule(data, 'react-native/Libraries/Image/AssetRegistry'),
      'module.exports = require("react-native/Libraries/Image/AssetRegistry").registerAsset({"__packager_asset":true,"httpServerLocation":"/assets/img","width":10,"scales":[1,2],"hash":"h","name":"a","type":"png"});\n',
    )
    assert.throws(() => assetModule(data), TypeError)
  })
})

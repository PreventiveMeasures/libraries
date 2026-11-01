import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assetDestPath, assetsDestFiles, filterPlatformAssetScales } from '../assets-dest.js'

const asset = (overrides = {}) => ({ httpServerLocation: '/assets/img', name: 'Logo-1', type: 'png', scales: [1, 2, 3], files: ['/p/img/Logo-1.png', '/p/img/Logo-1@2x.png', '/p/img/Logo-1@3x.png'], ...overrides })

describe('filterPlatformAssetScales', () => {
  it('keeps iOS to 1x to 3x, else the first above, else the largest', () => {
    assert.deepEqual(filterPlatformAssetScales('ios', [0.75, 1, 1.5, 2, 3, 4]), [1, 2, 3])
    assert.deepEqual(filterPlatformAssetScales('ios', [0.5, 4, 5]), [4])
    assert.deepEqual(filterPlatformAssetScales('ios', [0.5, 0.75]), [0.75])
    assert.deepEqual(filterPlatformAssetScales('ios', []), [])
  })

  it('keeps every scale elsewhere', () => {
    assert.deepEqual(filterPlatformAssetScales('android', [0.75, 1, 4]), [0.75, 1, 4])
  })
})

describe('assetDestPath', () => {
  it('lays Android out as resources', () => {
    assert.equal(assetDestPath(asset(), 2, 'android'), 'drawable-xhdpi/img_logo1.png')
    assert.equal(assetDestPath(asset(), 0.75, 'android'), 'drawable-ldpi/img_logo1.png')
    assert.equal(assetDestPath(asset(), 2.5, 'android'), 'drawable-400dpi/img_logo1.png')
    assert.equal(assetDestPath(asset({ type: 'heic' }), 1, 'android'), 'drawable-mdpi/img_logo1.heic')
    assert.equal(assetDestPath(asset({ type: 'mp3' }), 1, 'android'), 'raw/img_logo1.mp3')
    assert.equal(assetDestPath(asset({ httpServerLocation: '/assets/../up/a' }), 1, 'android'), 'drawable-mdpi/_up_a_logo1.png')
    assert.throws(() => assetDestPath(asset(), 0, 'android'), /no such scale 0/u)
  })

  it('lays iOS out by the asset\'s path', () => {
    assert.equal(assetDestPath(asset(), 1, 'ios'), 'assets/img/Logo-1.png')
    assert.equal(assetDestPath(asset(), 3, 'ios'), 'assets/img/Logo-1@3x.png')
    assert.equal(assetDestPath(asset({ httpServerLocation: '/assets/../up' }), 2, 'ios'), 'assets/_up/Logo-1@2x.png')
  })
})

describe('assetsDestFiles', () => {
  it('copies each file of a scale the platform takes', () => {
    assert.deepEqual(assetsDestFiles([asset({ scales: [1, 2, 4], files: ['/a.png', '/a@2x.png', '/a@4x.png'] })], 'ios'), [
      { src: '/a.png', dest: 'assets/img/Logo-1.png' },
      { src: '/a@2x.png', dest: 'assets/img/Logo-1@2x.png' },
    ])
  })

  it('keeps Android\'s resources from shrinking', () => {
    const files = assetsDestFiles([asset({ scales: [1], files: ['/a.png'] }), asset({ name: 'song', type: 'mp3', scales: [1], files: ['/s.mp3'] })], 'android')
    assert.deepEqual(files, [
      { src: '/a.png', dest: 'drawable-mdpi/img_logo1.png' },
      { src: '/s.mp3', dest: 'raw/img_song.mp3' },
      { dest: 'raw/keep.xml', contents: '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@drawable/img_logo1,@raw/img_song" />\n' },
    ])
    assert.deepEqual(assetsDestFiles([], 'android'), [])
  })

  it('copies a file reached twice where it last goes', () => {
    const files = assetsDestFiles([asset({ scales: [1], files: ['/a.png'] }), asset({ httpServerLocation: '/assets/x', scales: [1], files: ['/a.png'] })], 'ios')
    assert.deepEqual(files, [{ src: '/a.png', dest: 'assets/x/Logo-1.png' }])
  })
})

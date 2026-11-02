import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { defaults } from '../src/defaults.js'
import { maxWorkersOf } from '../src/metro-options.js'
import { extendedMetro, flagOf, metroConfigOf, readRnConfig } from '../src/rn-config.js'
import { writeTree } from './fixtures.js'

const fail = (message) => {
  throw new Error(message)
}

describe('readRnConfig', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' } })
  after(cleanup)
  const read = (text) => {
    writeFileSync(join(root, 'rn.config.json'), text)
    return readRnConfig(root, fail)
  }

  it('is {} of a project with none', () => {
    const { root: bare, cleanup: done } = writeTree({ 'package.json': { name: 'bare' } })
    try {
      assert.deepEqual(readRnConfig(bare, fail), {})
    } finally {
      done()
    }
  })

  it('takes each of its options, as they are', () => {
    const options = { metroConfig: false, assetExts: ['riv', 'tar.gz'], sourceExts: ['mjs'], assetResolutions: ['0.75', 5], maxWorkers: 2, esm: true, devTools: true }
    assert.deepEqual(read(JSON.stringify(options)), options)
    assert.deepEqual(read('{ "metroConfig": "metro.rn.config.js" }'), { metroConfig: 'metro.rn.config.js' })
    assert.deepEqual(read('{}'), {})
  })

  it('refuses an option it does not know, a value of another type, and a file not an object of JSON', () => {
    assert.throws(() => read('{ "devtools": true }'), { message: 'rn.config.json: no such option devtools: it has metroConfig, assetExts, sourceExts, assetResolutions, maxWorkers, esm, devTools' })
    for (const exts of [['.riv'], ['lib/x'], [''], 'riv', [1]]) {
      assert.throws(() => read(JSON.stringify({ assetExts: exts })), { message: `rn.config.json: assetExts is a list of extensions, each without its dot ("riv"), not ${JSON.stringify(exts)}` })
    }
    assert.throws(() => read('{ "sourceExts": [".mjs"] }'), { message: 'rn.config.json: sourceExts is a list of extensions, each without its dot ("riv"), not [".mjs"]' })
    for (const scales of [['@2x'], [0], ['-1'], [true], '2']) {
      assert.throws(() => read(JSON.stringify({ assetResolutions: scales })), { message: `rn.config.json: assetResolutions is a list of scales ("0.75", or 0.75), not ${JSON.stringify(scales)}` })
    }
    for (const workers of [0, 1.5, '2', null]) {
      assert.throws(() => read(JSON.stringify({ maxWorkers: workers })), { message: `rn.config.json: maxWorkers is a number of workers, 1 or more, not ${JSON.stringify(workers)}` })
    }
    assert.throws(() => read('{ "esm": "yes" }'), { message: 'rn.config.json: esm is true or false, not "yes"' })
    assert.throws(() => read('{ "devTools": 1 }'), { message: 'rn.config.json: devTools is true or false, not 1' })
    assert.throws(() => read('{ "metroConfig": "" }'), { message: 'rn.config.json: metroConfig is true, false or the path of a Metro config, not ""' })
    assert.throws(() => read('[]'), { message: 'rn.config.json: not an object of options' })
    assert.throws(() => read('null'), { message: 'rn.config.json: not an object of options' })
    assert.throws(() => read('{ esm: true }'), { message: /^rn\.config\.json: not JSON: /u })
  })

  it('fails where it is no file it reads', () => {
    const { root: odd, cleanup: done } = writeTree({ 'package.json': { name: 'odd' } })
    try {
      mkdirSync(join(odd, 'rn.config.json'))
      assert.throws(() => readRnConfig(odd, fail), { message: /^rn\.config\.json: EISDIR/u })
    } finally {
      done()
    }
  })
})

describe('metroConfigOf', () => {
  it("is --metro-config's, else the one Metro finds, none, or the file, as metroConfig has it", () => {
    assert.equal(metroConfigOf(undefined, {}), null)
    assert.equal(metroConfigOf(undefined, { metroConfig: true }), null)
    assert.equal(metroConfigOf(undefined, { metroConfig: false }), false)
    assert.equal(metroConfigOf(undefined, { metroConfig: 'metro.rn.config.js' }), 'metro.rn.config.js')
    for (const metroConfig of [true, false, 'metro.rn.config.js']) assert.equal(metroConfigOf('other.config.js', { metroConfig }), 'other.config.js')
  })
})

describe('extendedMetro', () => {
  // metroOptions()'s, of no config (its lists Metro's defaults), and of one.
  const none = { file: null, assetExts: defaults.assetExts, resolver: {}, maxWorkers: null }
  const loaded = { file: 'metro.config.js', assetExts: ['png', 'riv'], resolver: { sourceExts: ['js', 'cjs'], assetResolutions: ['1', '2'], mainFields: ['main'] }, maxWorkers: 4 }

  it('is the same, of a config of none of its lists, nor maxWorkers', () => {
    assert.equal(extendedMetro(loaded, { esm: true, metroConfig: true }, fail), loaded)
  })

  it("adds the config's to each list, after the Metro config's, else after Metro's defaults, each once", () => {
    const config = { assetExts: ['lottie', 'riv', 'lottie'], sourceExts: ['mjs'], assetResolutions: [0.75, '2', '1.25'] }
    const extended = extendedMetro(loaded, config, fail)
    assert.deepEqual([extended.assetExts, extended.resolver], [['png', 'riv', 'lottie'], { sourceExts: ['js', 'cjs', 'mjs'], assetResolutions: ['1', '2', '0.75', '1.25'], mainFields: ['main'] }])
    assert.deepEqual([extended.file, extended.maxWorkers], ['metro.config.js', 4])
    const fromDefaults = extendedMetro(none, config, fail)
    assert.deepEqual([fromDefaults.assetExts, fromDefaults.resolver], [[...defaults.assetExts, 'lottie', 'riv'], { sourceExts: [...defaults.sourceExts, 'mjs'], assetResolutions: [...defaults.assetResolutions, '0.75', '1.25'] }])
  })

  it("takes its maxWorkers over the Metro config's, --max-workers over it", () => {
    assert.deepEqual([undefined, '3'].map((given) => maxWorkersOf(given, extendedMetro(loaded, { maxWorkers: 2 }, fail), fail)), [2, 3])
    assert.equal(maxWorkersOf(undefined, extendedMetro(none, { maxWorkers: 1 }, fail), fail), 1)
    assert.equal(maxWorkersOf(undefined, extendedMetro(loaded, { assetExts: ['riv'] }, fail), fail), 4)
  })

  it('refuses an extension it adds to one of assetExts and sourceExts the other has, as it removes none', () => {
    assert.throws(() => extendedMetro(none, { sourceExts: ['svg'] }, fail), { message: 'rn.config.json: sourceExts adds svg, which assetExts has: Metro takes a file of it for an asset, and rn.config.json removes none' })
    assert.throws(() => extendedMetro(loaded, { assetExts: ['cjs'] }, fail), { message: 'rn.config.json: assetExts adds cjs, which sourceExts has: Metro takes a file of it for an asset, and rn.config.json removes none' })
    assert.throws(() => extendedMetro(none, { assetExts: ['glb'], sourceExts: ['glb'] }, fail), { message: /^rn\.config\.json: assetExts adds glb, which sourceExts has/u })
  })
})

describe('flagOf', () => {
  it("is the flag's, else the config's, else off, of what set it", () => {
    assert.deepEqual(flagOf(undefined, {}, 'esm', 'esm'), { on: false, by: "rn.config.json's esm" })
    assert.deepEqual(flagOf(undefined, { esm: true }, 'esm', 'esm'), { on: true, by: "rn.config.json's esm" })
    assert.deepEqual(flagOf(false, { esm: true }, 'esm', 'esm'), { on: false, by: '--esm' })
    assert.deepEqual(flagOf(true, {}, 'devTools', 'dev-tools'), { on: true, by: '--dev-tools' })
  })
})

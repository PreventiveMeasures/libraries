import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { flagOf, metroConfigOf, readRnConfig } from '../src/rn-config.js'
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

  it('takes metroConfig, esm and devTools, as they are', () => {
    const options = { metroConfig: false, esm: true, devTools: true }
    assert.deepEqual(read(JSON.stringify(options)), options)
    assert.deepEqual(read('{ "metroConfig": "metro.rn.config.js" }'), { metroConfig: 'metro.rn.config.js' })
    assert.deepEqual(read('{}'), {})
  })

  it('refuses an option it does not know, a value of another type, and a file not an object of JSON', () => {
    assert.throws(() => read('{ "devtools": true }'), { message: 'rn.config.json: no such option devtools: it has metroConfig, esm, devTools' })
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

describe('flagOf', () => {
  it("is the flag's, else the config's, else off, of what set it", () => {
    assert.deepEqual(flagOf(undefined, {}, 'esm', 'esm'), { on: false, by: "rn.config.json's esm" })
    assert.deepEqual(flagOf(undefined, { esm: true }, 'esm', 'esm'), { on: true, by: "rn.config.json's esm" })
    assert.deepEqual(flagOf(false, { esm: true }, 'esm', 'esm'), { on: false, by: '--esm' })
    assert.deepEqual(flagOf(true, {}, 'devTools', 'dev-tools'), { on: true, by: '--dev-tools' })
  })
})

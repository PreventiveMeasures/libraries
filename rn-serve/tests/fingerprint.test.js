import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { transformerOf } from '@preventive/rn/src/babel-transformer.js'
import { babelWorkers } from '@preventive/rn/src/babel-worker.js'
import { workerFingerprint } from '../src/fingerprint.js'
import { writeTree } from './fixtures.js'

const CORE = fileURLToPath(import.meta.resolve('@babel/core'))
// rn's Babel workers fingerprint with it, as rn-serve's cache has them.
const FINGERPRINTER = fileURLToPath(new URL('../src/fingerprint.js', import.meta.url))

// () => the thread a transform's file is transformed in (thread.cjs's): 0, the main thread.
const threader = (transform) => {
  let files = 0
  return async () => Number(/(\d+);$/u.exec((await transform('a()', `/t${files++}.js`)).code)[1])
}

describe('babelWorkers, asked for a fingerprint', () => {
  const { root, cleanup } = writeTree({
    'mark.cjs': "module.exports = ({ types: t }) => ({ name: 'mark', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral('marked'))) } } } })\n",
    'thread.cjs': "module.exports = ({ types: t }) => ({ name: 'thread', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.numericLiteral(require('node:worker_threads').threadId))) } } } })\n",
  })
  after(cleanup)
  const options = { babelrc: false, configFile: false, cwd: root, compact: false, plugins: [join(root, 'mark.cjs')] }

  it('gives one of what it loaded with the config, and its options, with the option alone', async () => {
    const { fingerprint, modules, reads, options: given } = await babelWorkers(CORE, { ...options, fingerprinter: FINGERPRINTER }, null, 1).fingerprint()
    assert.match(fingerprint, /^[\da-f]{64}$/u)
    assert.ok(modules.includes(CORE) && modules.includes(join(root, 'mark.cjs')))
    assert.ok(Array.isArray(reads))
    assert.deepEqual(given, { ...options, fingerprinter: FINGERPRINTER })
    assert.equal(babelWorkers(CORE, options, null, 1).fingerprint, undefined)
  })

  it("transforms in band still, but gives a worker's: of what Babel loaded, not of what the main thread has", async () => {
    const { threadOf, fingerprintOf } = (() => {
      const transform = babelWorkers(CORE, { ...options, plugins: [...options.plugins, join(root, 'thread.cjs')], fingerprinter: FINGERPRINTER }, null, 1)
      return { threadOf: threader(transform), fingerprintOf: () => transform.fingerprint() }
    })()
    // esbuild's, CommonJS, which the main thread has loaded, Babel not.
    const require = createRequire(import.meta.url)
    const esbuild = require.resolve('esbuild')
    require(esbuild)
    assert.deepEqual(await Promise.all([threadOf(), threadOf()]), [0, 0])
    const { fingerprint, modules } = await fingerprintOf()
    assert.ok(modules.includes(join(root, 'thread.cjs')) && !modules.includes(esbuild), String(modules))
    const fresh = babelWorkers(CORE, { ...options, plugins: [...options.plugins, join(root, 'thread.cjs')], fingerprinter: FINGERPRINTER }, null, 1)
    assert.equal((await fresh.fingerprint()).fingerprint, fingerprint)
  })
})

describe("Babel's workers, of plugins switched on", () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'plugins/reads.js': "require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'data.txt'))\nmodule.exports = () => ({ name: 'reads', visitor: {} })\n",
    'data.txt': 'data',
  })
  after(cleanup)

  it("have the fingerprint of the files a plugin added reads as Babel loads it, as of the config's", () => {
    const { fingerprint } = transformerOf({ corePath: createRequire(import.meta.url).resolve('@babel/core'), options: { cwd: root, root, babelrc: false, configFile: false, switches: [['./plugins/reads.js', true]] }, profile: false, fingerprintOf: workerFingerprint })
    assert.ok(fingerprint.reads.some(([path]) => path === join(root, 'data.txt')), JSON.stringify(fingerprint.reads))
  })
})

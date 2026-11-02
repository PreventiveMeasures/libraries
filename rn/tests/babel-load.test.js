import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { handlerOf } from '../src/babel-load.js'
import { pluginsByKey } from '../src/babel-transformer.js'
import { babelWorkers } from '../src/babel-worker.js'
import { loadFile } from '../src/load.js'

const require = createRequire(import.meta.url)
const CORE = fileURLToPath(import.meta.resolve('@babel/core'))
const ESBUILD = require.resolve('esbuild')
const FLOW = require.resolve('flow-remove-types')
const esbuild = require(ESBUILD)
const core = require(CORE)
const flowRemoveTypes = require(FLOW)
const stripFlow = Object.assign((source) => flowRemoveTypes(source, { all: true, removeEmptyImports: true }).toString(), { flowRemoveTypes: FLOW })
const projectRoot = '/p'
// A config of plugins loadFile() leaves out of Babel for a file, or keeps:
// Flow's and TS's, which esbuild's output has nothing for; CommonJS, of a
// file of no import; module-resolver, of aliases the bundle maps.
const options = {
  babelrc: false,
  configFile: false,
  compact: false,
  cwd: projectRoot,
  plugins: [require.resolve('@babel/plugin-transform-flow-strip-types'), require.resolve('@babel/plugin-transform-modules-commonjs'), [require.resolve('babel-plugin-module-resolver'), { alias: { '#lib': './lib' } }]],
}
const FILES = {
  '/p/flow.js': '// @flow\nimport type { T } from "./t"\nimport a from "#lib/a"\nexport const f = (x: number): T => a(x)\n',
  '/p/script.js': 'const g = async () => { await 1 }\nmodule.exports = g\n',
  '/p/typed.ts': 'import b from "#lib/b"\ntype U = string\nexport class C { x?: U; y = b }\n',
  '/p/esm.mjs': "export * as ns from './ns'\nexport default 1\n",
  '/p/broken.js': 'const = 1\n',
}
// The plugins of the config for a file, as cli.js's babelPlugins() has them, on the main thread.
const babelPlugins = async (filename) => pluginsByKey((await core.loadOptionsAsync({ ...options, filename })).plugins)

describe('babelWorkers().load, a file loaded whole off the main thread', () => {
  for (const keepPlugins of [false, true]) {
    it(`loads each file as loadFile() does on the main thread${keepPlugins ? ', with keepPlugins (in a worker)' : ''}`, async () => {
      // With keepPlugins, each file in a worker: none in band.
      const babel = babelWorkers(CORE, { ...options, esbuildPath: ESBUILD, ...(keepPlugins && { keepPlugins }) })
      // The main thread's: a transform alone.
      const main = (...args) => babel(...args)
      for (const [path, contents] of Object.entries(FILES)) {
        for (const esm of [false, new Set(), new Set([path])]) {
          for (const sourcemap of [false, true]) {
            const expected = await loadFile({ esbuild, projectRoot, stripFlow, babel: main, babelPlugins, sourcemap, esm, keepPlugins }, path, contents)
            const loaded = await babel.load({ path, contents, projectRoot, sourcemap, keepPlugins, esm: esm === false ? false : esm.has(path) ? 'commonjs' : 'module', flow: FLOW })
            assert.deepEqual(loaded, expected, `${path} ${esm === false ? '' : [...esm]} ${sourcemap}`)
          }
        }
      }
    })
  }

  it("counts the config Babel loads for a file in the file's time, in its profile", async () => {
    // A config of an override whose test takes 20 ms each time Babel loads it for a file.
    const slow = () => {
      const end = performance.now() + 20
      while (performance.now() < end);
      return false
    }
    const handle = handlerOf({ corePath: CORE, options: { ...options, overrides: [{ test: slow }], esbuildPath: ESBUILD }, profile: true })
    // Of no let or const, which lowerLeft() would load the config again for.
    const { spent } = await handle({ load: { path: '/p/plain.js', contents: 'var a = 1\n', projectRoot, sourcemap: false, keepPlugins: false, esm: false, flow: FLOW } })
    const [, , configMs] = spent.own.find(([name]) => name === 'config')
    assert.ok(configMs >= 20 && spent.ms >= configMs, `${spent.ms} ms, of which config ${configMs} ms`)
  })

  it("loads a file whole only by the bundle's esbuild, of flow-remove-types or no Flow stripping, and where a worker is idle", async () => {
    const asked = []
    const load = Object.assign((request) => {
      asked.push(request.path)
      return Promise.resolve({ contents: 'loaded', loader: 'js' })
    }, { esbuild, spare: () => true })
    const babel = Object.assign((code) => Promise.resolve(code), { load })
    const none = () => Promise.resolve(new Map())
    const of = (overrides = {}) => loadFile({ esbuild, projectRoot, stripFlow, babel, babelPlugins: none, ...overrides }, '/p/a.js', 'a()\n')
    assert.deepEqual(await of(), { contents: 'loaded', loader: 'js' })
    assert.deepEqual(await of({ stripFlow: null }), { contents: 'loaded', loader: 'js' })
    for (const overrides of [{ esbuild: { ...esbuild } }, { stripFlow: (source) => source }, { babel: Object.assign((code) => Promise.resolve(code), { load: { ...load, spare: () => false } }) }]) {
      assert.notEqual((await of(overrides)).contents, 'loaded', Object.keys(overrides)[0])
    }
    // JSON, as esbuild loads it, on the main thread.
    assert.deepEqual(await loadFile({ esbuild, projectRoot, stripFlow, babel, babelPlugins: none }, '/p/a.json', '{}'), { contents: '{}', loader: 'json' })
    assert.deepEqual(asked, ['/p/a.js', '/p/a.js'])
  })
})

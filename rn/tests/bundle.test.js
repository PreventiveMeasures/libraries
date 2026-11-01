import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { bundle, createBundler } from '../src/bundle.js'
import { writeTree } from './fixtures.js'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const core = require('@babel/core')

const APP = {
  'index.js': "import { value } from './lib/value'\nimport { typed, fail } from './lib/typed'\nglobalThis.result = [value, typed]\nglobalThis.fail = fail\n",
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

  it('builds again and again on one context, each build reading the files anew, and says which it read', async () => {
    const bundler = await createBundler(options)
    try {
      const first = await bundler.rebuild()
      assert.deepEqual(run(js(first)), [1, 2])
      assert.deepEqual(first.files.toSorted(), files('index.js', 'lib/typed.ts', 'lib/value.js'))
      writeFileSync(join(root, 'lib/value.js'), 'export const value = 3\n')
      assert.deepEqual(run(js(await bundler.rebuild())), [3, 2])
      writeFileSync(join(root, 'lib/value.js'), 'export const value = (\n')
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.ok(error.files.includes(join(root, 'lib/value.js')))
    } finally {
      writeFileSync(join(root, 'lib/value.js'), APP['lib/value.js'])
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
      assert.deepEqual(transformed.toSorted(), ['index.js', 'typed.ts', 'value.js'])
      writeFileSync(join(root, 'lib/value.js'), 'export const value = 4\n')
      assert.deepEqual(run(js(await bundler.rebuild())), [4, 2])
      assert.deepEqual(transformed.toSorted(), ['index.js', 'typed.ts', 'value.js', 'value.js'])
    } finally {
      writeFileSync(join(root, 'lib/value.js'), APP['lib/value.js'])
      await bundler.dispose()
    }
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

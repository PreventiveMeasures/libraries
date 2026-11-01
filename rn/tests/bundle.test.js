import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { bundle, createBundler } from '../src/bundle.js'
import { png, writeTree } from './fixtures.js'

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

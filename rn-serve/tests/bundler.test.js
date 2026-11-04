import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { createBundler } from '../src/bundler.js'
import { png, writeTree } from './fixtures.js'

const esbuild = createRequire(import.meta.url)('esbuild')

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
describe('createBundler, of source paths', () => {
  it('reads output maps only when inputs were renamed, resetting that decision on each rebuild', async () => {
    const { root, cleanup } = writeTree({
      'index.js': '',
      'plain.js': 'export const value = 1\n',
      'module.mjs': 'export const value = 2\n',
      'typed.mts': 'export const value: number = 3\n',
    })
    let reads = 0
    const counted = { ...esbuild, context: async (options) => {
      const context = await esbuild.context(options)
      return { ...context, rebuild: async () => {
        const result = await context.rebuild()
        return { ...result, outputFiles: result.outputFiles.map((file) => file.path.endsWith('.map') ? {
          path: file.path, contents: file.contents,
          get text() { reads++; return file.text },
        } : file) }
      } }
    } }
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild: counted, projectRoot: root, sourcemap: true })
    try {
      for (const [file, value, expectedReads] of [['plain.js', 1, 0], ['module.mjs', 2, 1], ['typed.mts', 3, 1], ['plain.js', 1, 0]]) {
        writeFileSync(join(root, 'index.js'), `import { value } from './${file}'\nglobalThis.result = value\n`)
        reads = 0
        const result = await bundler.rebuild()
        assert.equal(reads, expectedReads, file)
        assert.equal(run(js(result)), value)
        const map = JSON.parse(result.outputFiles.find((output) => output.path.endsWith('.map')).text)
        assert.ok(map.sources.some((source) => source.endsWith(file)), file)
        assert.ok(!map.sources.some((source) => /\.m[jt]s\.rn\.[jt]s$/u.test(source)))
      }
    } finally {
      await bundler.dispose()
      cleanup()
    }
  })
})
describe('createBundler', () => {
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
})

describe('createBundler, of an asset it cannot build', () => {
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

describe('createBundler, of a manifest that is no JSON', () => {
  const { root, cleanup } = writeTree({ 'package.json': '{', 'index.js': 'globalThis.result = 1\n' })
  after(cleanup)

  it('fails the build, not the bundler, and says it read it, so that a watcher sees it fixed', async () => {
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.equal(error.errors.length, 1, error.errors.map(({ text }) => text).join('\n'))
      assert.ok(error.files.includes(join(root, 'package.json')), String(error.files))
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
      assert.equal(run(js(await bundler.rebuild())), 1)
    } finally {
      await bundler.dispose()
    }
  })
})

describe('createBundler, of an import written before its module', () => {
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

describe('createBundler, of a file not UTF-8', () => {
  // Latin-1's é, which UTF-8 has no character of alone; and a UTF-8 BOM, which is UTF-8.
  const latin1 = Buffer.concat([Buffer.from("module.exports = 'caf"), Buffer.from([0xe9]), Buffer.from("'\n")])
  const { root, cleanup } = writeTree({ 'index.js': "globalThis.result = [require('./lib/name'), require('./lib/bom')]\n", 'lib/name.js': latin1, 'lib/bom.js': "﻿module.exports = 'bom'\n" })
  after(cleanup)

  it('fails to load it, not taking its bytes for U+FFFD, and says it read it, so that a watcher sees it fixed', async () => {
    const bundler = await createBundler({ entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.match(error?.errors?.[0]?.text ?? '', /Not UTF-8/u)
      assert.equal(error.errors[0].location?.file, 'lib/name.js')
      assert.ok(error.files.includes(join(root, 'lib/name.js')), String(error.files))
      writeFileSync(join(root, 'lib/name.js'), "module.exports = 'café'\n")
      assert.deepEqual(run(js(await bundler.rebuild())), ['café', 'bom'])
    } finally {
      await bundler.dispose()
    }
  })
})

describe('createBundler, of an entry not there', () => {
  const { root, cleanup } = writeTree({ 'src/other.txt': '' })
  after(cleanup)

  it('says it looked for it, so that a watcher sees it made', async () => {
    const bundler = await createBundler({ entry: 'src/index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root })
    try {
      const error = await bundler.rebuild().then(() => null, (failure) => failure)
      assert.ok(Array.isArray(error?.errors), String(error))
      assert.ok(error.files.includes(join(root, 'src/index.js')), String(error.files))
      writeFileSync(join(root, 'src/index.js'), 'globalThis.result = 1\n')
      assert.equal(run(js(await bundler.rebuild())), 1)
    } finally {
      await bundler.dispose()
    }
  })
})

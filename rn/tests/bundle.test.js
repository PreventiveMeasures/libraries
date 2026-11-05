import assert from 'node:assert/strict'
import { SourceMap, createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { buildHost, newState } from '../src/build-host.js'
import { bundle } from '../src/bundle.js'
import { diskHost } from '../src/defaults.js'
import { restrictionsOf } from '../src/restrictions.js'
import { png, vfsOf, writeTree } from './fixtures.js'

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

  it('reads ahead each file it resolves, off the main thread, and loads it of what it read; else, failing, as the host reads it', async () => {
    const ahead = []
    const readFileAsync = (path) => {
      ahead.push(basename(path))
      return Promise.resolve(path.endsWith('value.js') ? Buffer.from('export const value = 5\n') : diskHost.readFile(path))
    }
    const result = await bundle({ ...options, host: { ...diskHost, readFileAsync } })
    assert.deepEqual(run(js(result)), [5, 2, 'dep'])
    assert.deepEqual(ahead.toSorted(), ['index.js', 'main.js', 'typed.ts', 'value.js'])
    for (const file of files('index.js', 'lib/typed.ts', 'lib/value.js', 'node_modules/dep/lib/main.js')) assert.ok(result.files.includes(file), file)
    const failing = await bundle({ ...options, host: { ...diskHost, readFileAsync: () => Promise.reject(new Error('EIO')) } })
    assert.deepEqual(run(js(failing)), [1, 2, 'dep'])
    assert.ok(failing.files.includes(join(root, 'lib/value.js')))
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
describe("buildHost, a build's host", () => {
  it('asks the host of each path once: a file, a directory, a real path; and notes each file it looks for or reads', () => {
    const asked = []
    const host = { isFile: (path) => asked.push(['isFile', path]) > 0 && path.endsWith('.js'), isDirectory: (path) => asked.push(['isDirectory', path]) > 0 && !path.endsWith('.js'), realpath: (path) => asked.push(['realpath', path]) && path, readFile: () => '' }
    const read = new Set()
    const once = buildHost(host, read)
    for (let i = 0; i < 2; i++) assert.deepEqual([once.isFile('/a.js'), once.isFile('/b'), once.isDirectory('/b'), once.realpath('/a.js')], [true, false, true, '/a.js'])
    assert.deepEqual(asked, [['isFile', '/a.js'], ['isFile', '/b'], ['isDirectory', '/b'], ['realpath', '/a.js']])
    once.readFile('/c.js')
    assert.deepEqual([...read], ['/a.js', '/b', '/c.js'])
  })
})

describe("buildHost, of a host that lists directories", () => {
  const { root, cleanup } = writeTree({
    'src/a.js': '',
    'src/b.ios.js': '',
    'src/dir/index.js': '',
    'linked.js': { link: 'src/a.js' },
    'linked-dir': { link: 'src/dir' },
  })
  after(cleanup)

  it("answers whether a path is a file or a directory as its directory lists it, a link as the host has it", () => {
    const host = buildHost(diskHost, new Set())
    const paths = ['src/a.js', 'src/b.ios.js', 'src/b.js', 'src/dir', 'src/dir/index.js', 'src/nothing/a.js', 'linked.js', 'linked-dir', 'linked-dir/index.js', 'src/a.js/x', 'src']
    for (const path of paths.map((name) => join(root, name))) {
      assert.deepEqual([host.isFile(path), host.isDirectory(path)], [diskHost.isFile(path), diskHost.isDirectory(path)], path)
    }
    // Of its names as they are, as Metro's file map has them.
    assert.equal(host.isFile(join(root, 'src/A.js')), false)
    assert.equal(host.isDirectory('/'), true)
  })

  it('lists each directory once, and leaves a host that lists none as it is', () => {
    const listed = []
    const host = buildHost({ ...diskHost, dirents: (dir) => listed.push(dir) && diskHost.dirents(dir) }, new Set())
    for (const name of ['a.js', 'b.ios.js', 'b.native.js', 'b.js', 'dir']) host.isFile(join(root, 'src', name))
    assert.deepEqual(listed, [join(root, 'src')])
    const plain = buildHost({ isFile: (path) => path === '/a.js', isDirectory: () => false }, new Set())
    assert.deepEqual([plain.isFile('/a.js'), plain.isFile('/b.js')], [true, false])
    // A directory not to be listed, but searched (EACCES, of mode 0111):
    // each path in it as the host has it. One not there: nothing in it.
    const asked = []
    const failing = (code) => () => {
      throw Object.assign(new Error(code), { code })
    }
    const locked = buildHost({ isFile: (path) => asked.push(path) > 0 && path === '/locked/a.js', isDirectory: () => false, dirents: failing('EACCES') }, new Set())
    assert.deepEqual([locked.isFile('/locked/a.js'), locked.isFile('/locked/b.js'), asked], [true, false, ['/locked/a.js', '/locked/b.js']])
    for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(buildHost({ isFile: () => true, isDirectory: () => true, dirents: failing(code) }, new Set()).isFile('/gone/a.js'), false, code)
    // @preventive/vfs's, whose `entries` are an archive's, not a directory's: as the host has it.
    const vfs = vfsOf({ 'index.js': '', 'lib/a.js': '' })
    const ofVfs = buildHost(vfs, new Set())
    assert.deepEqual([ofVfs.isFile('/lib/a.js'), ofVfs.isDirectory('/lib'), ofVfs.isFile('/lib')], [true, true, false])
    const state = newState({ host: vfs, assetExts: [], projectRoot: '/', entry: 'index.js', platform: 'ios' })
    assert.deepEqual(state.resolveImport('/index.js', './lib/a', 'import-statement'), { kind: 'file', key: '/lib/a.js' })
    assert.deepEqual(state.graph.get('/index.js').get('./lib/a'), { type: 'sourceFile', filePath: '/lib/a.js' })
  })
})

describe("bundle, of rn.config.json's restrictions", () => {
  const { root, cleanup } = writeTree({ ...APP, 'polyfill.js': 'globalThis.polyfilled = true\n', 'linked.js': { link: 'private/polyfill.js' }, 'private/polyfill.js': 'globalThis.polyfilled = true\n' })
  after(cleanup)
  const options = { entry: 'index.js', platform: 'ios', outfile: 'out.js', esbuild, projectRoot: root, polyfills: [join(root, 'polyfill.js')] }
  const errorsOf = async (config, more = {}) => {
    const failure = await bundle({ ...options, restrict: restrictionsOf(config, root), ...more }).then(() => null, (error) => error)
    return failure?.errors?.map(({ text, location }) => [text, location === null ? null : `${location.file}:${location.line}`]) ?? []
  }

  it('builds what they allow', async () => {
    const result = await bundle({ ...options, restrict: restrictionsOf({ allowedPaths: ['*.js', 'lib/*.{js,ts}', 'node_modules/**'], allowedModules: ['app', 'dep'], disallowedModules: ['other'] }, root) })
    assert.deepEqual(run(js(result)), [1, 2, 'dep'])
  })

  it('fails on each file of each import they forbid, at the import', async () => {
    assert.deepEqual(await errorsOf({ disallowedModules: ['dep'] }), [[`node_modules/dep/lib/main.js is of dep, which matches "dep" of rn.config.json's disallowedModules`, 'index.js:3']])
    // The project's own files, of its package.json's name; esbuild goes no further than an entry it fails on.
    assert.deepEqual(await errorsOf({ allowedModules: ['dep'] }), [["index.js is of app, which matches none of rn.config.json's allowedModules", null]])
    assert.deepEqual(await errorsOf({ allowedPaths: ['*.js', 'node_modules/**'], disallowedPaths: ['**/main.js'] }), [
      ["lib/value.js matches none of rn.config.json's allowedPaths", 'index.js:1'],
      ["lib/typed.ts matches none of rn.config.json's allowedPaths", 'index.js:2'],
      [`node_modules/dep/lib/main.js matches "**/main.js" of rn.config.json's disallowedPaths`, 'index.js:3'],
    ])
  })

  it('fails on the entry, and on a polyfill', async () => {
    assert.deepEqual((await errorsOf({ disallowedPaths: ['index.js'] }))[0], ["index.js matches \"index.js\" of rn.config.json's disallowedPaths", null])
    assert.deepEqual((await errorsOf({ allowedPaths: ['index.js', 'lib/**', 'node_modules/**'] }))[0][0], "polyfill.js matches none of rn.config.json's allowedPaths")
  })

  it("checks a polyfill by its real path, from the project root where it isn't absolute", async () => {
    for (const polyfill of [join(root, 'linked.js'), 'linked.js']) {
      assert.deepEqual(await errorsOf({ disallowedPaths: ['private/**'] }, { polyfills: [polyfill] }), [[`private/polyfill.js matches "private/**" of rn.config.json's disallowedPaths`, 'metro-main:index.js:1']], polyfill)
    }
  })
})

describe("bundle, of rn.config.json's restrictions of an asset", () => {
  // The files Metro builds of logo.png: logo.ios.png alone for ios; for android, logo.png, logo@3x.png (a link to
  // private/hidden.png) and logo@5x.png, a scale its import doesn't resolve to.
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'index.js': "globalThis.result = require('./logo.png')\n",
    'logo.png': png(2, 2),
    'logo.ios.png': png(2, 2),
    'logo@3x.png': { link: 'private/hidden.png' },
    'private/hidden.png': png(6, 6),
    'logo@5x.png': png(10, 10),
    'registry.js': 'module.exports = { registerAsset: () => 1 }\n',
  })
  after(cleanup)
  const errorsOf = async (platform, disallowedPaths) => {
    const options = { entry: 'index.js', platform, outfile: 'out.js', esbuild, projectRoot: root, assetRegistryPath: './registry.js', restrict: restrictionsOf({ disallowedPaths }, root) }
    const failure = await bundle(options).then(() => null, (error) => error)
    return failure?.errors?.map(({ text, location }) => [text, `${location.file}:${location.line}`]) ?? []
  }

  it('checks each file the build takes of it for the platform, not those its import resolves to', async () => {
    assert.deepEqual(await errorsOf('ios', ['logo.ios.png']), [[`logo.ios.png matches "logo.ios.png" of rn.config.json's disallowedPaths`, 'index.js:1']])
    assert.deepEqual(await errorsOf('ios', ['logo.png', 'logo@5x.png']), [])
    assert.deepEqual(await errorsOf('android', ['logo.ios.png']), [])
    assert.deepEqual(await errorsOf('android', ['*@5x.png']), [[`logo@5x.png matches "*@5x.png" of rn.config.json's disallowedPaths`, 'index.js:1']])
  })

  it('checks the real path of a file of it that is a link', async () => {
    assert.deepEqual(await errorsOf('android', ['private/**']), [[`private/hidden.png matches "private/**" of rn.config.json's disallowedPaths`, 'index.js:1']])
    assert.deepEqual(await errorsOf('android', ['logo@3x.png']), [])
  })
})

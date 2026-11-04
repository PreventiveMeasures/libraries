import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createAliases } from '../babel-aliases.js'
import { createMetroLoader } from '../metro-loader.js'
import { ANY } from '../src/bundle.js'
import { printed, writeTree } from './fixtures.js'
import { APP, BABEL_APP, MODERN, OPTIONS, esbuild, linked, runBundle } from './rn-bundle-app.js'

// The loader's onResolve and onLoad, as a test runner's build takes them.
const plugin = (loader) => ({
  name: 'metro-loader',
  setup(build) {
    build.onResolve({ filter: ANY }, (args) => loader.resolve(args))
    build.onLoad({ filter: ANY }, (args) => loader.load(args))
  },
})

// What a build with the loader of `entry` (a path, or esbuild's stdin) prints, as JSON.
async function built(loader, root, entry) {
  const outfile = join(root, 'loaded.out.js')
  const input = typeof entry === 'string' ? { entryPoints: [entry] } : { stdin: entry }
  await esbuild.build({ ...input, absWorkingDir: root, outfile, bundle: true, format: 'iife', platform: 'neutral', logLevel: 'silent', define: loader.define, tsconfigRaw: loader.tsconfigRaw, supported: await loader.supported(), plugins: [plugin(loader)] })
  return JSON.parse(printed(outfile))
}

// What rn-bundle of these args builds `entry` to print, as JSON.
async function bundled(root, args, entry) {
  const r = await runBundle([...args, '--output=bundled.out.js', entry], { cwd: root })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(printed(join(root, 'bundled.out.js')))
}

// Each test's loaders closed after it, in the project's directory, as module-resolver's cwd, without the
// shell's BABEL_ENV, and with the NODE_ENV rn-bundle sets for a release build, which Babel's plugins read.
function project(tree) {
  const { root, cleanup } = writeTree(tree)
  const was = { cwd: process.cwd(), BABEL_ENV: process.env.BABEL_ENV, NODE_ENV: process.env.NODE_ENV }
  const loaders = []
  before(() => {
    process.chdir(root)
    delete process.env.BABEL_ENV
    process.env.NODE_ENV = 'production'
  })
  after(async () => {
    await Promise.all(loaders.map((loader) => loader.close()))
    process.chdir(was.cwd)
    for (const name of ['BABEL_ENV', 'NODE_ENV']) {
      if (was[name] === undefined) delete process.env[name]
      else process.env[name] = was[name]
    }
    cleanup()
  })
  const loaderOf = (options) => {
    const loader = createMetroLoader({ projectRoot: root, platform: 'ios', esbuild, ...options })
    loaders.push(loader)
    return loader
  }
  return { root, loaderOf }
}

describe('createMetroLoader, without a Babel config', () => {
  const { root, loaderOf } = project({
    ...APP,
    'node_modules/redirected/package.json': { name: 'redirected', main: 'index.js', 'react-native': { './unused.js': false } },
    'node_modules/redirected/index.js': "module.exports = require('./unused')\n",
    'node_modules/redirected/unused.js': "throw new Error('never run')\n",
    'lib/changing.js': 'export const changing = 1\n',
  })
  const aliases = createAliases(APP['aliases.json'], root)

  it('builds each module as rn-bundle does, for each platform: Flow, aliases, platform files, package fields, assets', async () => {
    for (const platform of ['ios', 'android']) {
      const loader = loaderOf({ platform, aliases })
      assert.deepEqual(await built(loader, root, 'index.js'), await bundled(root, [`--platform=${platform}`, ...OPTIONS], 'index.js'))
    }
  })

  it("defines __DEV__ and NODE_ENV as Metro's prelude sets them, and has esbuild lower nothing it wouldn't", async () => {
    assert.deepEqual(loaderOf({ dev: true }).define, { __DEV__: 'true', 'process.env.NODE_ENV': '"development"' })
    const release = loaderOf({})
    assert.deepEqual(release.define, { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' })
    assert.deepEqual(await release.supported(), {})
    assert.equal(release.tsconfigRaw, undefined)
  })

  it("builds an asset into the module assetSource gives of the lowest path of its scales, Metro's where none", async () => {
    const testUri = (path) => `module.exports = ${JSON.stringify({ testUri: relative(root, path) })}\n`
    const { ids } = await built(loaderOf({ aliases, assetSource: testUri }), root, 'index.js')
    assert.deepEqual(ids, [{ testUri: 'img/logo.png' }, { testUri: 'img/icon.png' }, { testUri: 'fonts/Inter.ttf' }])
  })

  it('resolves as Metro does: the empty module of a false redirect, nothing where Metro resolves nothing', async () => {
    const loader = loaderOf({ aliases })
    const from = (importer) => ({ importer: join(root, importer), namespace: 'file', kind: 'require-call' })
    const empty = loader.resolve({ ...from('node_modules/redirected/index.js'), path: './unused' })
    assert.deepEqual(empty, { path: 'empty', namespace: 'metro-empty' })
    assert.deepEqual(await loader.load(empty), { contents: '', loader: 'js' })
    assert.equal(loader.resolve({ ...from('lib/optional.js'), path: '@shopify/flash-list' }), undefined)
    // A file's import without its pluginData, aliases given: mapped by them.
    assert.deepEqual(loader.resolve({ ...from('index.js'), path: '#lib/greet', kind: 'import-statement' }), { path: join(root, 'lib/greet.js') })
  })

  it("resolves an entry point as a path, and another namespace's imports (stdin's) from resolveDir", async () => {
    const loader = loaderOf({ aliases })
    const entry = (path) => loader.resolve({ path, importer: '', namespace: '', resolveDir: root, kind: 'entry-point' })
    assert.deepEqual(entry('index.js'), { path: join(root, 'index.js') })
    assert.equal(entry('missing.js'), undefined)
    assert.equal(await built(loader, root, { contents: "import { where } from './lib/where'\nconsole.log(JSON.stringify(where))\n", resolveDir: root }), 'ios')
  })

  it('loads a file again only when its contents change', async () => {
    const loader = loaderOf({ aliases })
    const args = { path: join(root, 'lib/changing.js') }
    const first = await loader.load(args)
    assert.equal(await loader.load(args), first)
    writeFileSync(args.path, 'export const changing = 2\n')
    const changed = await loader.load(args)
    assert.notEqual(changed, first)
    assert.match(changed.contents, /changing = 2/u)
  })

  it("reports a file it can't load in that file", async () => {
    const { errors } = await loaderOf({ aliases }).load({ path: join(root, 'lib/broken.js') })
    assert.equal(errors.length, 1)
    assert.equal(errors[0].location.file, 'lib/broken.js')
  })
})

describe('createMetroLoader, with a Babel config', () => {
  const { root, loaderOf } = project({
    ...BABEL_APP,
    'block/babel.config.js': "module.exports = { plugins: ['./block-scoping.js'] }\n",
    'block/block-scoping.js': "module.exports = () => ({ name: 'transform-block-scoping', visitor: {} })\n",
    'block/node_modules/@babel/core': linked('@babel/core'),
  })
  const RELEASE = OPTIONS.filter((option) => !option.startsWith('--babel-aliases'))

  it("builds each module as rn-bundle does with the project's Babel config: its env, caller and lowering", async () => {
    const loader = loaderOf({})
    assert.deepEqual(await built(loader, root, 'index.js'), await bundled(root, ['--platform=ios', ...RELEASE], 'index.js'))
    const modern = await built(loader, root, 'modern.js')
    assert.deepEqual(modern, MODERN)
    assert.deepEqual(modern, await bundled(root, ['--platform=ios', ...RELEASE], 'modern.js'))
  })

  it('has esbuild lower the class syntax Babel leaves, and add no let or const where the config lowers them', async () => {
    const supported = await loaderOf({}).supported()
    assert.equal(supported['class-field'], false)
    assert.equal(supported['const-and-let'], undefined)
    assert.equal((await loaderOf({ projectRoot: join(root, 'block') }).supported())['const-and-let'], false)
  })

  it('refuses aliases of its own where the Babel config has its aliases', () => {
    assert.throws(() => loaderOf({ aliases: createAliases({ '#lib': './lib' }, root) }), { message: "createMetroLoader: aliases map the imports where no Babel runs: the project's Babel config has its aliases" })
  })
})

describe("createMetroLoader, module-resolver's aliases and CommonJS", () => {
  const { root, loaderOf } = project({
    'babel.config.js': "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib' } }], '@babel/plugin-transform-modules-commonjs'] }\n",
    'lib/where.ios.js': "export const where = 'ios'\n",
    'lib/where.android.js': "export const where = 'android'\n",
    'plain.js': "import { where } from '#lib/where'\nexport const plain = where\n",
    'mocks.js': "jest.mock('#lib/where')\nexport { where } from '#lib/where'\n",
    'index.js': "import { plain } from './plain'\nimport value, { named } from 'esm-only'\nconsole.log(JSON.stringify([plain, value, named]))\n",
    'node_modules/esm-only/package.json': { name: 'esm-only', main: 'index.mjs' },
    'node_modules/esm-only/index.mjs': "export default 'default'\nexport const named = 'named'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
    'node_modules/babel-plugin-module-resolver': linked('babel-plugin-module-resolver'),
  })

  it("maps them as rn-bundle does: in Babel where it maps a call's string (jest.mock), else as it resolves", async () => {
    const loader = loaderOf({})
    const plain = await loader.load({ path: join(root, 'plain.js') })
    assert.deepEqual(plain.pluginData.aliases, { alias: { '#lib': './lib' }, cwd: root })
    assert.match(plain.contents, /require\("#lib\/where"\)/u)
    const args = { path: '#lib/where', importer: join(root, 'plain.js'), namespace: 'file', kind: 'require-call' }
    assert.deepEqual(loader.resolve({ ...args, pluginData: plain.pluginData }), { path: join(root, 'lib/where.ios.js') })
    assert.equal(loader.resolve(args), undefined)
    const mocks = await loader.load({ path: join(root, 'mocks.js') })
    assert.equal(mocks.pluginData?.aliases, undefined)
    assert.match(mocks.contents, /jest\.mock\(["']\.\/lib\/where["']\)/u)
  })

  it('builds as rn-bundle does, a .mjs file that Babel makes CommonJS by a path esbuild takes as a script', async () => {
    const loader = loaderOf({})
    const found = loader.resolve({ path: 'esm-only', importer: join(root, 'index.js'), namespace: 'file', kind: 'import-statement' })
    assert.deepEqual(found, { path: join(root, 'node_modules/esm-only/index.mjs.rn.js') })
    assert.equal(loader.realPath(found.path), join(root, 'node_modules/esm-only/index.mjs'))
    const out = await built(loader, root, 'index.js')
    assert.deepEqual(out, ['ios', 'default', 'named'])
    assert.deepEqual(out, await bundled(root, ['--platform=ios'], 'index.js'))
    assert.deepEqual(await built(loaderOf({ platform: 'android' }), root, 'index.js'), ['android', 'default', 'named'])
  })
})

describe('createMetroLoader, refusing options', () => {
  it("refuses what isn't an option it takes", () => {
    const base = { projectRoot: '/p', platform: 'ios', esbuild }
    const refused = [
      [undefined, 'takes an options object'],
      [{ ...base, projectRoot: 'p' }, 'projectRoot is an absolute path'],
      [{ ...base, platform: '' }, 'platform is a platform name, e.g. ios'],
      [{ ...base, esbuild: {} }, 'esbuild is the esbuild module the build is made with'],
      [{ ...base, dev: 'yes' }, 'dev and sourcemap are booleans'],
      [{ ...base, transformProfile: 'hermes' }, 'transformProfile is one of default, hermes-stable, hermes-canary'],
      [{ ...base, resolver: null }, "resolver is Metro's resolver options"],
      [{ ...base, aliases: { '#lib': './lib' } }, "aliases is babel-aliases.js's createAliases() of the aliases"],
      [{ ...base, assetSource: 'x' }, "assetSource is a function of an asset's path to its module's source"],
    ]
    for (const [options, message] of refused) assert.throws(() => createMetroLoader(options), { name: 'TypeError', message: `createMetroLoader: ${message}` })
  })
})

describe("createMetroLoader, with Babel's TS plugin keeping imports and fields", () => {
  const { root, loaderOf } = project({
    'babel.config.js': "module.exports = { plugins: [['@babel/plugin-transform-typescript', { onlyRemoveTypeImports: true, allowDeclareFields: true }]] }\n",
    'main.ts': "import { Mark } from './mark'\nimport { Child } from './fields'\nconst mark: Mark | null = null\nconsole.log(JSON.stringify({ effects: (globalThis as any).effects ?? [], field: new Child().value ?? null }))\n",
    // Has a side effect; imported only for its type.
    'mark.ts': ";((globalThis as any).effects ??= []).push('mark')\nexport type Mark = string\n",
    'fields.ts': "class Base { value: string = 'base' }\nexport class Child extends Base { value: string }\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-typescript': linked('@babel/plugin-transform-typescript'),
  })

  it("builds TS as rn-bundle does, where Babel's output keeps each import and field Babel kept", async () => {
    const out = await built(loaderOf({}), root, 'main.ts')
    assert.deepEqual(out, { effects: ['mark'], field: null })
    assert.deepEqual(out, await bundled(root, ['--platform=ios'], 'main.ts'))
  })
})

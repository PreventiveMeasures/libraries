import assert from 'node:assert/strict'
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { babelWorkers } from '@preventive/rn/src/babel-worker.js'
import { bundleRequest } from '../src/bundle-url.js'
import { hotUpdate, moduleName, moduleUrls } from '../src/hot.js'
import { createLoadCache } from '../src/load-cache.js'
import { createModuleBundler } from '../src/modules.js'
import { restrictionsOf } from '@preventive/rn/src/restrictions.js'
import { prelude } from '@preventive/rn/src/serializer.js'
import { png, writeTree } from './fixtures.js'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const RUNTIME = require.resolve('metro-runtime/src/polyfills/require.js')
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })

// As react-native sets Fast Refresh up before the entry (setUpReactRefresh):
// react-refresh's runtime, its refreshes and full refreshes counted.
const INITIALIZE_CORE = [
  "const Refresh = require('react-refresh/runtime')",
  'const perform = Refresh.performReactRefresh',
  'Refresh.performReactRefresh = () => { globalThis.refreshes++; return perform() }',
  'Refresh.performFullRefresh = (reason) => { globalThis.fullRefreshes.push(reason) }',
  'globalThis.__ReactRefresh = Refresh',
  "globalThis.log.push('InitializeCore')",
  '',
].join('\n')

const APP = {
  'index.js': "import { Greeting } from './Greeting'\nimport { logo } from './Logo'\nlog.push('index')\nglobalThis.app = { Greeting, logo }\n",
  'Greeting.js': "import { label } from './label'\nlog.push('Greeting')\nexport function Greeting() {\n  return 'Hello ' + label\n}\n",
  'label.js': "log.push('label')\nexport const label = 'world'\n",
  // CommonJS, strict, with an optional dependency, which isn't there.
  'Logo.js': "'use strict'\nlet flash = 'none'\ntry {\n  flash = require('@shopify/flash-list')\n} catch (error) {\n  flash = error.code\n}\nlet strict = false\ntry {\n  undeclared = 1\n} catch {\n  strict = true\n}\nexports.logo = { id: require('./img/logo.png'), flash, strict }\n",
  'img/logo.png': png(20, 10),
  'polyfill.js': "globalThis.log = ['polyfill']\nglobalThis.refreshes = 0\nglobalThis.fullRefreshes = []\n",
  'node_modules/react-native/package.json': { name: 'react-native', version: '0.81.0' },
  'node_modules/react-native/Libraries/Core/InitializeCore.js': INITIALIZE_CORE,
  'node_modules/react-native/Libraries/Image/AssetRegistry.js': 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n',
  'node_modules/react-refresh': linked('react-refresh'),
}

// The bundle run as an app runs it. -> { context, inject(update) }: its
// global object, and an update injected as metro-runtime's HMRClient does.
function run(js) {
  const context = createContext({ console, setTimeout, clearTimeout })
  runInContext('globalThis.global = globalThis', context)
  runInContext(js, context)
  const inject = ({ added, modified }) => {
    for (const { module: [, code] } of [...added, ...modified]) runInContext(code, context)
  }
  return { context, inject }
}
const value = (context, expression) => JSON.parse(runInContext(`JSON.stringify(${expression})`, context))

describe('the module format, of names JSON and JavaScript read otherwise', () => {
  // A package named __proto__, which a key of JSON.stringify() in code would make the prototype of the
  // module's dependency map; and a file named with U+2028, which ends a string literal before ES2019.
  const LS = String.fromCodePoint(0x2028)
  const { root, cleanup } = writeTree({
    'index.js': `import proto from '__proto__'\nimport separated from './a${LS}b'\nglobalThis.out = [proto, separated]\n`,
    [`a${LS}b.js`]: "export default 'separated'\n",
    'node_modules/__proto__/package.json': { name: '__proto__', main: 'index.js' },
    'node_modules/__proto__/index.js': "module.exports = 'proto'\n",
  })
  after(cleanup)

  it('requires each, its name in its definition escaped', async () => {
    const { js } = await createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, ids: new Map(), builds: new Map(), cache: new Map() }).rebuild()
    assert.ok(!js.includes(LS))
    const { context } = run(js)
    assert.deepEqual(value(context, 'globalThis.out'), ['proto', 'separated'])
  })
})

describe('the module format, of a deep graph with shared dependencies and a cycle', () => {
  const count = 96
  const { root, cleanup } = writeTree({
    'index.js': "globalThis.result = require('./m0').value\n",
    'shared.js': 'exports.step = 1\n',
    ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`m${i}.js`, i === count - 1
      ? "exports.value = require('./shared').step; exports.first = () => require('./m0')\n"
      : `exports.value = require('./m${i + 1}').value + require('./shared').step\n`])),
  })
  after(cleanup)

  it('finishes each module once, including dependencies found by cached modules on a later build', async () => {
    const modules = createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, cache: new Map() })
    try {
      for (let build = 0; build < 2; build++) {
        const progress = []
        const result = await modules.rebuild((done, total) => progress.push([done, total]))
        assert.equal(result.modules.size, count + 2)
        assert.equal(run(result.js).context.result, count)
        assert.deepEqual(progress.map(([done]) => done), Array.from({ length: count + 2 }, (_, i) => i + 1))
        assert.deepEqual(progress[progress.length - 1], [count + 2, count + 2])
      }
    } finally {
      await modules.dispose()
    }
  })
})

describe('hotUpdate', () => {
  it('ignores reused and equivalent records, and notices dependency ids and their order changing', () => {
    const record = { id: 0, name: 'index.js', factory: 'function () {}', deps: [1, 2] }
    const before = { modules: new Map([[record.id, record]]) }
    const update = (next) => hotUpdate(before, { modules: new Map([[next.id, next]]), version: 1 }, 'http://localhost:8081/index.bundle?platform=ios')
    assert.equal(update(record), null)
    assert.equal(update({ ...record, deps: [...record.deps] }), null)
    for (const deps of [[2, 1], [1, 3], [1], []]) {
      const changed = update({ ...record, deps })
      assert.deepEqual(changed.modified.map(({ module: [id] }) => id), [record.id])
      assert.deepEqual(changed.added, [])
      assert.deepEqual(changed.deleted, [])
    }
  })
})

describe('the module format', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const bundler = () => createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, ids: new Map(), builds: new Map(), cache: new Map() })
  const edit = (file, contents) => writeFileSync(join(root, file), contents)
  const restore = () => {
    for (const file of ['index.js', 'Greeting.js', 'label.js']) edit(file, APP[file])
    rmSync(join(root, 'extra.js'), { force: true })
  }
  const CLIENT = 'http://localhost:8081/index.bundle?platform=ios&dev=true'

  it('reuses unchanged runtime scripts, rebuilding edited scripts and keeping their maps current', async () => {
    for (const runtime of [RUNTIME, require.resolve('metro-runtime-0.81/src/polyfills/require.js')]) {
      const transformed = []
      const counting = { ...esbuild, transform: (code, options) => (transformed.push(options.sourcefile), esbuild.transform(code, options)) }
      const options = { entry: 'index.js', platform: 'ios', esbuild: counting, projectRoot: root, runtime, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, ids: new Map(), cache: new Map() }
      const modules = createModuleBundler(options)
      try {
        const first = await modules.rebuild()
        assert.equal(transformed.length, 2)
        transformed.length = 0
        const again = await modules.rebuild()
        assert.deepEqual([again.js, again.map], [first.js, first.map])
        assert.equal(transformed.length, 0)
        edit('polyfill.js', APP['polyfill.js'].replace("['polyfill']", "['edited polyfill']"))
        const changed = await modules.rebuild()
        assert.deepEqual(transformed, ['polyfill.js'])
        assert.equal(run(changed.js).context.log[0], 'edited polyfill')
        const fresh = await createModuleBundler({ ...options, cache: new Map() }).rebuild()
        assert.deepEqual([changed.js, changed.map], [fresh.js, fresh.map])
        // A failed edit must not serve the previous successful script.
        edit('polyfill.js', 'const broken = (\n')
        await assert.rejects(modules.rebuild(), /Build failed/u)
        edit('polyfill.js', APP['polyfill.js'])
        const restored = await modules.rebuild()
        assert.deepEqual([restored.js, restored.map], [first.js, first.map])
      } finally {
        edit('polyfill.js', APP['polyfill.js'])
        await modules.dispose()
      }
    }
  })

  it("makes the bundle, and its map, each as it is first asked for, each module's record and definition the build before's where it is the same, to the bundle built anew", async () => {
    const ids = new Map()
    const builds = new Map()
    const cache = new Map()
    const make = (more = {}) => createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, ids, builds, cache, ...more })
    try {
      const first = await make().rebuild()
      assert.equal(typeof Object.getOwnPropertyDescriptor(first, 'js').get, 'function', 'made as it is asked for')
      const again = await make().rebuild()
      assert.ok([...again.modules].every(([id, record]) => record === first.modules.get(id)))
      edit('label.js', APP['label.js'].replace("'world'", "'edited world'"))
      const edited = await make().rebuild()
      assert.deepEqual([...edited.modules.values()].filter((record) => record !== first.modules.get(record.id)).map(({ name }) => name), ['label.js'])
      const anew = await make({ builds: new Map(), cache: new Map() }).rebuild()
      assert.deepEqual([edited.js === anew.js, edited.map === anew.map], [true, true])
      assert.match(edited.js, /edited world/u)
    } finally {
      restore()
    }
  })

  it("keeps each module's build in a store, which a run after takes, building none, to the same bundle", async () => {
    let built = 0
    const counting = { ...esbuild, build: (...args) => (built++, esbuild.build(...args)) }
    // A run of its own: its own module ids, builds and files in memory.
    // A build of it, its store's pack written as it ends.
    const runOf = async () => {
      const each = createLoadCache(join(root, 'store'), { esbuild })(null)
      each.start()
      const result = await createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild: counting, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, ids: new Map(), builds: new Map(), cache: new Map(), store: each }).rebuild()
      await each.finish().written
      return result
    }
    try {
      const first = await runOf()
      const made = built
      assert.ok(made > 0)
      const second = await runOf()
      assert.equal(built, made)
      // Each module the same, by its name, though of other ids, which a
      // run gives as it reaches each.
      const shape = ({ modules }) => [...modules.values()].map(({ name, factory }) => [name, factory]).toSorted(([a], [b]) => (a < b ? -1 : 1))
      assert.deepEqual(shape(second), shape(first))
      assert.deepEqual(JSON.stringify(run(second.js).context.app), JSON.stringify(run(first.js).context.app))
      edit('label.js', `${APP['label.js']}// Edited.\n`)
      await runOf()
      assert.equal(built, made + 1)
    } finally {
      restore()
      rmSync(join(root, 'store'), { recursive: true, force: true })
    }
  })

  it("runs as Metro's: the prelude, metro-runtime's require and the polyfills, what runs before the entry, then the entry", async () => {
    const { js, modules, entryId } = await bundler().rebuild()
    assert.ok(js.startsWith(`${prelude('true', 'development')}\n(function (global) {\n`))
    assert.ok(js.endsWith(`__r(${entryId});\n`))
    assert.equal(modules.get(entryId).name, 'index.js')
    const { context } = run(js)
    assert.deepEqual(value(context, 'log'), ['polyfill', 'InitializeCore', 'label', 'Greeting', 'index'])
    assert.equal(value(context, 'app.Greeting()'), 'Hello world')
    // The optional dependency fails as Node's would, in its try block; the module stays strict.
    assert.deepEqual(value(context, '{ flash: app.logo.flash, strict: app.logo.strict }'), { flash: 'MODULE_NOT_FOUND', strict: true })
    assert.equal(value(context, 'typeof app.logo.id'), 'number')
  })

  it('keeps each module strict that was, minified too', async () => {
    const { js } = await createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, minify: true }).rebuild()
    assert.equal(value(run(js).context, 'app.logo.strict'), true)
  })

  it('maps each line of a module to its source', async () => {
    const { js, map } = await bundler().rebuild()
    const lines = js.split('\n')
    const line = lines.findIndex((text) => text.includes("return 'Hello ' + label") || text.includes('return "Hello " + import_label.label'))
    const { originalSource, originalLine } = new SourceMap(JSON.parse(map)).findEntry(line, lines[line].indexOf('return'))
    assert.deepEqual([originalSource, originalLine + 1], ['Greeting.js', 4])
  })

  it('refreshes a module of components alone, as Fast Refresh does, where it is edited', async () => {
    const modules = bundler()
    const first = await modules.rebuild()
    const { context, inject } = run(first.js)
    try {
      edit('Greeting.js', APP['Greeting.js'].replace("'Hello '", "'Hi '"))
      const second = await modules.rebuild()
      const update = hotUpdate({ ...first, version: 1 }, { ...second, version: 2 }, CLIENT)
      assert.deepEqual([update.added, update.deleted, update.modified.map(({ module: [id] }) => second.modules.get(id).name)], [[], [], ['Greeting.js']])
      inject(update)
      await sleep(60)
      // Run anew alone, its importer not; refreshed, not reloaded.
      assert.deepEqual(value(context, 'log').slice(5), ['Greeting'])
      assert.deepEqual(value(context, '[refreshes, fullRefreshes]'), [1, []])
      const id = [...second.modules.values()].find(({ name }) => name === 'Greeting.js').id
      assert.equal(runInContext(`__r(${id}).Greeting()`, context), 'Hi world')
    } finally {
      restore()
    }
  })

  it('runs anew the importers of a module that is no boundary, up to one that is', async () => {
    const modules = bundler()
    const first = await modules.rebuild()
    const { context, inject } = run(first.js)
    try {
      edit('label.js', APP['label.js'].replace("'world'", "'there'"))
      inject(hotUpdate(first, await modules.rebuild(), CLIENT))
      await sleep(60)
      assert.deepEqual(value(context, 'log').slice(5), ['label', 'Greeting'])
      assert.deepEqual(value(context, '[refreshes, fullRefreshes]'), [1, []])
    } finally {
      restore()
    }
  })

  it('reloads where no module up to the entry is a boundary', async () => {
    const modules = bundler()
    const first = await modules.rebuild()
    const { context, inject } = run(first.js)
    try {
      edit('index.js', `${APP['index.js']}log.push('edited')\n`)
      inject(hotUpdate(first, await modules.rebuild(), CLIENT))
      await sleep(60)
      assert.equal(value(context, 'fullRefreshes.length'), 1)
    } finally {
      restore()
    }
  })

  it('adds a module an edit imports, and deletes one none imports any more', async () => {
    const modules = bundler()
    const first = await modules.rebuild()
    const { context, inject } = run(first.js)
    try {
      edit('extra.js', "export const extra = '!'\n")
      edit('Greeting.js', `import { extra } from './extra'\n${APP['Greeting.js'].replace("'Hello ' + label", "'Hello ' + label + extra")}`)
      const second = await modules.rebuild()
      const added = hotUpdate(first, second, CLIENT)
      assert.deepEqual(added.added.map(({ module: [id] }) => second.modules.get(id).name), ['extra.js'])
      inject(added)
      await sleep(60)
      const id = [...second.modules.values()].find(({ name }) => name === 'Greeting.js').id
      assert.equal(runInContext(`__r(${id}).Greeting()`, context), 'Hello world!')
      edit('Greeting.js', APP['Greeting.js'])
      const deleted = hotUpdate(second, await modules.rebuild(), CLIENT)
      assert.deepEqual(deleted.deleted, [[...second.modules.values()].find(({ name }) => name === 'extra.js').id])
    } finally {
      restore()
    }
  })

  it("names each module's code and map as Metro does, for the module alone, and its importers up to the entry", async () => {
    const modules = bundler()
    const first = await modules.rebuild()
    try {
      edit('label.js', APP['label.js'].replace("'world'", "'there'"))
      const second = await modules.rebuild()
      const update = hotUpdate(first, second, 'http://10.0.0.2:8081/index.bundle?platform=ios&dev=true&lazy=true&excludeSource=true')
      const [{ module: [id, code], sourceURL, sourceMappingURL }] = update.modified
      assert.equal(sourceMappingURL, 'http://10.0.0.2:8081/label.js.map?platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true')
      assert.equal(sourceURL, 'http://10.0.0.2:8081/label.js.bundle//&platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true')
      assert.ok(code.endsWith(`//# sourceMappingURL=${sourceMappingURL}\n//# sourceURL=${sourceURL}\n`))
      const idOf = (name) => [...second.modules.values()].find((record) => record.name === name).id
      const inverse = JSON.parse(/,(\{[^}]*\})\);\n\/\/# sourceMappingURL/u.exec(code)[1])
      assert.deepEqual(inverse, { [id]: [idOf('Greeting.js')], [idOf('Greeting.js')]: [idOf('index.js')], [idOf('index.js')]: [] })
      assert.equal(hotUpdate(second, second, CLIENT), null)
      // Unless the client is to know a build failed no more.
      assert.deepEqual(hotUpdate(second, { ...second, version: 3 }, CLIENT, { always: true }), { revisionId: '3', isInitialUpdate: false, added: [], modified: [], deleted: [] })
    } finally {
      restore()
    }
  })

  it('fails on an import that resolves to nothing but in a try block, as esbuild does, and says what it read', async () => {
    const modules = bundler()
    const { size } = (await modules.rebuild()).modules
    try {
      edit('label.js', "import './missing'\nexport const label = 1\n")
      const error = await modules.rebuild().then(() => null, (failure) => failure)
      assert.match(error?.errors?.[0]?.text ?? '', /Could not resolve "\.\/missing"/u)
      assert.ok(error.files.includes(join(root, 'missing.js')), String(error.files))
      restore()
      assert.equal((await modules.rebuild()).modules.size, size)
    } finally {
      restore()
    }
  })
})

describe('the module format, with metro-runtime 0.81 (react-native 0.78)', () => {
  const { root, cleanup } = writeTree({
    ...APP,
    // As Babel's preset makes a module CommonJS: its exports values.
    'Greeting.js': "Object.defineProperty(exports, '__esModule', { value: true })\nlog.push('Greeting')\nexports.Greeting = function Greeting() {\n  return 'Hello'\n}\n",
    'Card.js': "log.push('Card')\nexport function Card() {\n  return 'card'\n}\n",
    'index.js': "import { Greeting } from './Greeting'\nimport { Card } from './Card'\nlog.push('index')\nglobalThis.app = { Greeting, Card }\n",
  })
  after(cleanup)
  const bundler = () => createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: require.resolve('metro-runtime-0.81/src/polyfills/require.js'), polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' } })
  const edited = async (file, from, to) => {
    const modules = bundler()
    const first = await modules.rebuild()
    const { context, inject } = run(first.js)
    const original = readFileSync(join(root, file), 'utf8')
    try {
      writeFileSync(join(root, file), original.replace(from, to))
      inject(hotUpdate(first, await modules.rebuild(), 'http://localhost:8081/index.bundle?platform=ios'))
      await sleep(60)
      return value(context, '[refreshes, fullRefreshes.length]')
    } finally {
      writeFileSync(join(root, file), original)
    }
  }

  it('refreshes a module whose exports are values, as Babel makes them', async () => {
    assert.deepEqual(await edited('Greeting.js', "'Hello'", "'Hi'"), [1, 0])
  })

  it("reloads where esbuild makes one CommonJS, its exports getters, which this runtime takes for no boundary", async () => {
    assert.deepEqual(await edited('Card.js', "'card'", "'Card'"), [0, 1])
  })
})

describe("the module format, of the project's Babel output, its imports require calls", () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'index.js': "import cond from 'cond'\nglobalThis.app = { cond, required: require('./required') }\n",
    'required.js': "module.exports = require('cond')\n",
    // As the package's exports have it, for an import and for a require call.
    'node_modules/cond/package.json': { name: 'cond', exports: { import: './esm.js', require: './cjs.js' } },
    'node_modules/cond/esm.js': "export default 'import'\n",
    'node_modules/cond/cjs.js': "module.exports = 'require'\n",
  })
  after(cleanup)

  it('resolves an import Babel makes a require call as an ESM import, as Metro does', async () => {
    const babel = babelWorkers(fileURLToPath(import.meta.resolve('@babel/core')), { babelrc: false, configFile: false, compact: false, plugins: [fileURLToPath(import.meta.resolve('@babel/plugin-transform-modules-commonjs'))] })
    const { js } = await createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, babel }).rebuild()
    assert.deepEqual(value(run(js).context, 'app'), { cond: 'import', required: 'require' })
  })
})

describe("the module format, of babel-plugin-module-resolver's aliases", () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'index.js': "import { a } from '#lib/a'\nglobalThis.app = { a, b: require('#lib/b') }\n",
    'lib/a.js': "export const a = 'a'\n",
    'lib/b.js': "module.exports = 'b'\n",
  })
  after(cleanup)

  it('maps each import Babel leaves of an alias as module-resolver maps it, as it resolves it', async () => {
    const resolver = [fileURLToPath(import.meta.resolve('babel-plugin-module-resolver')), { alias: { '#lib': './lib' }, cwd: root }]
    const babel = babelWorkers(fileURLToPath(import.meta.resolve('@babel/core')), { babelrc: false, configFile: false, compact: false, plugins: [fileURLToPath(import.meta.resolve('@babel/plugin-transform-modules-commonjs')), resolver] })
    const babelPlugins = () => Promise.resolve(new Map([['transform-modules-commonjs', {}], ['module-resolver', resolver[1]]]))
    const { js } = await createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, babel, babelPlugins }).rebuild()
    assert.deepEqual(value(run(js).context, 'app'), { a: 'a', b: 'b' })
    // Its require calls of the specifiers as written: Babel left them.
    assert.match(js, /"#lib\/a":0/u)
  })
})

describe("the module format, of rn.config.json's restrictions", () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, ...APP })
  after(cleanup)
  const rebuild = (config) => createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME, polyfills: [join(root, 'polyfill.js')], prelude: prelude('true', 'development'), define: { __DEV__: 'true' }, restrict: restrictionsOf(config, root) }).rebuild()
  const errorsOf = async (config) => {
    const failure = await rebuild(config).then(() => null, (error) => error)
    return failure?.errors.map(({ text, location }) => [text, location?.file ?? null]) ?? []
  }

  it("builds what they allow, rn's own runtime not restricted", async () => {
    // metro-runtime's require.js, of rn-serve's node_modules, is of a package allowedModules lacks.
    const { js } = await rebuild({ allowedPaths: ['*.js', 'img/**', 'node_modules/**', '../**'], allowedModules: ['app', 'react-native', 'react-refresh'] })
    const { context } = run(js)
    assert.deepEqual(value(context, 'globalThis.app.logo.id'), 1)
  })

  it('fails on each file of each import they forbid, in the module that imports it', async () => {
    assert.deepEqual(await errorsOf({ disallowedPaths: ['img/*.png'] }), [[`img/logo.png matches "img/*.png" of rn.config.json's disallowedPaths`, 'Logo.js']])
    assert.deepEqual(await errorsOf({ disallowedModules: ['react-refresh'] }), [[`${relative(root, require.resolve('react-refresh/runtime')).replaceAll('\\', '/')} is of react-refresh, which matches "react-refresh" of rn.config.json's disallowedModules`, 'node_modules/react-native/Libraries/Core/InitializeCore.js']])
  })

  it('fails on the entry, a module run before it, and a polyfill', async () => {
    assert.deepEqual(await errorsOf({ disallowedPaths: ['{index,polyfill}.js', '**/InitializeCore.js'] }), [
      [`index.js matches "{index,polyfill}.js" of rn.config.json's disallowedPaths`, null],
      [`node_modules/react-native/Libraries/Core/InitializeCore.js matches "**/InitializeCore.js" of rn.config.json's disallowedPaths`, null],
      [`polyfill.js matches "{index,polyfill}.js" of rn.config.json's disallowedPaths`, null],
    ])
  })
})

describe('moduleUrls', () => {
  it('names a module out of the project root by `[..]`, which a URL keeps, and moduleName() reads back', () => {
    const { sourceMappingURL } = moduleUrls('http://h:1/index.bundle?platform=ios', '../../ui/Component.tsx')
    assert.equal(new URL(sourceMappingURL).pathname, '/[..]/[..]/ui/Component.tsx.map')
    assert.equal(moduleName(bundleRequest(new URL(sourceMappingURL)).entryFile), '../../ui/Component.tsx')
  })

  it('puts the module in the path, encoded, its extension then that of a bundle or a map', () => {
    assert.deepEqual(moduleUrls('https://h:1/x.bundle?bundleEntry=x.bundle&platform=android', 'src/a b/App.tsx'), {
      sourceURL: 'http://h:1/src/a%20b/App.tsx.bundle//&platform=android&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true',
      sourceMappingURL: 'http://h:1/src/a%20b/App.tsx.map?platform=android&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true',
    })
  })
})

// The runtime as react-native 0.88 has it, which reads its require off its path.
assert.ok(readFileSync(RUNTIME, 'utf8').includes('__accept'))

describe('the module format, of a manifest that is no JSON', () => {
  const { root, cleanup } = writeTree({ 'package.json': '{', 'index.js': 'globalThis.result = 1\n' })
  after(cleanup)

  it('fails the build, not the bundler, and says it read it, so that a watcher sees it fixed', async () => {
    const modules = createModuleBundler({ entry: 'index.js', platform: 'ios', esbuild, projectRoot: root, runtime: RUNTIME })
    const error = await modules.rebuild().then(() => null, (failure) => failure)
    assert.ok(Array.isArray(error?.errors), String(error))
    assert.ok(error.files.includes(join(root, 'package.json')), String(error.files))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }))
    assert.equal((await modules.rebuild()).modules.size, 1)
  })
})

import assert from 'node:assert/strict'
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { bundleRequest } from '../src/bundle-url.js'
import { hotUpdate, moduleName, moduleUrls } from '../src/hot.js'
import { createModuleBundler } from '../src/modules.js'
import { prelude } from '../src/serializer.js'
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
      assert.equal(sourceMappingURL, 'http://10.0.0.2:8081/label.map?platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true')
      assert.equal(sourceURL, 'http://10.0.0.2:8081/label.bundle//&platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true')
      assert.ok(code.endsWith(`//# sourceMappingURL=${sourceMappingURL}\n//# sourceURL=${sourceURL}\n`))
      const idOf = (name) => [...second.modules.values()].find((record) => record.name === name).id
      const inverse = JSON.parse(/,(\{[^}]*\})\);\n\/\/# sourceMappingURL/u.exec(code)[1])
      assert.deepEqual(inverse, { [id]: [idOf('Greeting.js')], [idOf('Greeting.js')]: [idOf('index.js')], [idOf('index.js')]: [] })
      assert.equal(hotUpdate(second, second, CLIENT), null)
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

describe('moduleUrls', () => {
  it('names a module out of the project root by `[..]`, which a URL keeps, and moduleName() reads back', () => {
    const { sourceMappingURL } = moduleUrls('http://h:1/index.bundle?platform=ios', '../../ui/Component.tsx')
    assert.equal(new URL(sourceMappingURL).pathname, '/[..]/[..]/ui/Component.map')
    assert.equal(moduleName(bundleRequest(new URL(sourceMappingURL)).entryFile), '../../ui/Component')
  })

  it('puts the module in the path, encoded, its extension that of a bundle or a map', () => {
    assert.deepEqual(moduleUrls('https://h:1/x.bundle?bundleEntry=x.bundle&platform=android', 'src/a b/App.tsx'), {
      sourceURL: 'http://h:1/src/a%20b/App.bundle//&platform=android&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true',
      sourceMappingURL: 'http://h:1/src/a%20b/App.map?platform=android&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true',
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

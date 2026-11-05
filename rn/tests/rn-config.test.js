import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { defaults } from '../src/defaults.js'
import { maxWorkersOf } from '../src/metro-options.js'
import { babelSwitchesOf, extendedMetro, flagOf, inMode, inlineRequiresOf, metroConfigOf, readRnConfig, withInlineRequires } from '../src/rn-config.js'
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

  it('takes each of its options, as they are', () => {
    const options = { metroConfig: false, assetExts: ['riv', 'tar.gz'], sourceExts: ['mjs'], assetResolutions: ['0.75', 5], maxWorkers: 2, esm: true, devtools: true, port: 8082, launch: 'ios', allowedPaths: ['./index.js', 'src/**', 'node_modules/**'], disallowedPaths: ['src/{legacy,old}/**'], allowedModules: ['app', 'react*', '@react-native/*'], disallowedModules: ['moment'], ios: { simulator: 'iPhone 17 (26.0)', binaryPath: 'build/App.app' }, android: { device: 'Pixel_8', variant: 'freeDebug', binaryPath: 'app.apk' } }
    assert.deepEqual(read('{ "launch": false, "ios": {} }'), { launch: false, ios: {} })
    assert.deepEqual(read('{ "launch": "android" }'), { launch: 'android' })
    assert.deepEqual(read(JSON.stringify(options)), options)
    assert.deepEqual(read('{ "metroConfig": "metro.rn.config.js" }'), { metroConfig: 'metro.rn.config.js' })
    assert.deepEqual(read('{}'), {})
  })

  it('refuses an option it does not know, a value of another type, and a file not an object of JSON', () => {
    // devTools, its name before: none now.
    assert.throws(() => read('{ "devTools": true }'), { message: 'rn.config.json: no such option devTools: it has metroConfig, assetExts, sourceExts, assetResolutions, maxWorkers, esm, inlineRequires, babel, devtools, port, launch, allowedPaths, disallowedPaths, allowedModules, disallowedModules, ios, android, development, production' })
    for (const port of [-1, 65_536, 80.5, '8082', null]) {
      assert.throws(() => read(JSON.stringify({ port })), { message: `rn.config.json: port is a port, 0 to 65535, not ${JSON.stringify(port)}` })
    }
    assert.throws(() => read('{ "launch": "windows" }'), { message: 'rn.config.json: launch is "ios", "android", or false, not "windows"' })
    assert.throws(() => read('{ "android": { "mode": "debug" } }'), { message: 'rn.config.json: no such option android.mode: it has device, variant, binaryPath' })
    assert.throws(() => read('{ "android": { "variant": "" } }'), { message: 'rn.config.json: android.variant is a build variant\'s name, as debuggableVariants has it ("debug", "freeDebug"), not ""' })
    assert.throws(() => read('{ "ios": [] }'), { message: 'rn.config.json: ios is an object of options (simulator, binaryPath), not []' })
    assert.throws(() => read('{ "ios": { "udid": "X" } }'), { message: 'rn.config.json: no such option ios.udid: it has simulator, binaryPath' })
    assert.throws(() => read('{ "ios": { "binaryPath": "" } }'), { message: 'rn.config.json: ios.binaryPath is the path of a simulator\'s build of the app, an .app, not ""' })
    for (const exts of [['.riv'], ['lib/x'], [''], 'riv', [1]]) {
      assert.throws(() => read(JSON.stringify({ assetExts: exts })), { message: `rn.config.json: assetExts is a list of extensions, each without its dot ("riv"), not ${JSON.stringify(exts)}` })
    }
    assert.throws(() => read('{ "sourceExts": [".mjs"] }'), { message: 'rn.config.json: sourceExts is a list of extensions, each without its dot ("riv"), not [".mjs"]' })
    for (const scales of [['@2x'], [0], ['-1'], [true], '2']) {
      assert.throws(() => read(JSON.stringify({ assetResolutions: scales })), { message: `rn.config.json: assetResolutions is a list of scales ("0.75", or 0.75), not ${JSON.stringify(scales)}` })
    }
    for (const workers of [0, 1.5, '2', null]) {
      assert.throws(() => read(JSON.stringify({ maxWorkers: workers })), { message: `rn.config.json: maxWorkers is a number of workers, 1 or more, not ${JSON.stringify(workers)}` })
    }
    for (const globs of [['/app/src/**'], ['src\\**'], [''], ['src/{a,b'], ['src/../secrets'], ['src//x'], ['.'], 'src/**', [1]]) {
      assert.throws(() => read(JSON.stringify({ disallowedPaths: globs })), { message: `rn.config.json: disallowedPaths is a list of globs of paths from the project root, each a directory's files too ("src", "src/**/*.js", "node_modules"), not ${JSON.stringify(globs)}` })
    }
    for (const names of [['react-native/Libraries'], ['@scope'], ['@scope/a/b'], ['./x'], ['{react,'], [''], 'react']) {
      assert.throws(() => read(JSON.stringify({ allowedModules: names })), { message: `rn.config.json: allowedModules is a list of globs of packages' names ("react-native", "@react-native/*"), not ${JSON.stringify(names)}` })
    }
    assert.throws(() => read('{ "development": { "allowedPaths": [] } }'), { message: 'rn.config.json: no such option development.allowedPaths: it has babel, esm, inlineRequires' })
    assert.throws(() => read('{ "esm": "yes" }'), { message: 'rn.config.json: esm is true or false, not "yes"' })
    assert.throws(() => read('{ "devtools": 1 }'), { message: 'rn.config.json: devtools is true or false, not 1' })
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

describe('extendedMetro', () => {
  // metroOptions()'s, of no config (its lists Metro's defaults), and of one.
  const none = { file: null, assetExts: defaults.assetExts, resolver: {}, maxWorkers: null }
  const loaded = { file: 'metro.config.js', assetExts: ['png', 'riv'], resolver: { sourceExts: ['js', 'cjs'], assetResolutions: ['1', '2'], mainFields: ['main'] }, maxWorkers: 4 }

  it('is the same, of a config of none of its lists, nor maxWorkers', () => {
    assert.equal(extendedMetro(loaded, { esm: true, metroConfig: true }, fail), loaded)
  })

  it("adds the config's to each list, after Metro's defaults (the Metro config's, which sets none of them), each once", () => {
    const config = { assetExts: ['lottie', 'riv', 'lottie'], sourceExts: ['mjs'], assetResolutions: [0.75, '2', '1.25'] }
    const extended = extendedMetro(loaded, config, fail)
    assert.deepEqual([extended.assetExts, extended.resolver], [['png', 'riv', 'lottie'], { sourceExts: ['js', 'cjs', 'mjs'], assetResolutions: ['1', '2', '0.75', '1.25'], mainFields: ['main'] }])
    assert.deepEqual([extended.file, extended.maxWorkers], ['metro.config.js', 4])
    const fromDefaults = extendedMetro(none, config, fail)
    assert.deepEqual([fromDefaults.assetExts, fromDefaults.resolver], [[...defaults.assetExts, 'lottie', 'riv'], { sourceExts: [...defaults.sourceExts, 'mjs'], assetResolutions: [...defaults.assetResolutions, '0.75', '1.25'] }])
  })

  it("takes its maxWorkers over the Metro config's, --max-workers over it", () => {
    assert.deepEqual([undefined, '3'].map((given) => maxWorkersOf(given, extendedMetro(loaded, { maxWorkers: 2 }, fail), fail)), [2, 3])
    assert.equal(maxWorkersOf(undefined, extendedMetro(none, { maxWorkers: 1 }, fail), fail), 1)
    assert.equal(maxWorkersOf(undefined, extendedMetro(loaded, { assetExts: ['riv'] }, fail), fail), 4)
  })

  it("takes a list the Metro config loaded sets alike, Metro's defaults and the same, refusing one it sets otherwise", () => {
    // Of Metro's defaults, and @react-native/metro-config's over them; the config's assetExts its own (riv), its sourceExts and assetResolutions the second's.
    const defaultLists = [{ assetExts: ['png'], sourceExts: ['js'], assetResolutions: ['1'] }, { assetExts: ['png'], sourceExts: ['js', 'cjs'], assetResolutions: ['1', '2'] }]
    const own = { ...loaded, defaultLists }
    // Alike: assetExts as a set, scales of numbers too.
    assert.deepEqual(extendedMetro(own, { assetExts: ['riv'] }, fail).assetExts, ['png', 'riv'])
    assert.deepEqual(extendedMetro({ ...own, assetExts: ['riv', 'png'] }, { assetExts: ['riv'] }, fail).assetExts, ['riv', 'png'])
    assert.deepEqual(extendedMetro({ ...own, resolver: { ...own.resolver, assetResolutions: ['1', '2', '0.75'] } }, { assetResolutions: [0.75] }, fail).resolver.assetResolutions, ['1', '2', '0.75'])
    // Of a list the Metro config sets as a default has it, the config's added.
    assert.deepEqual(extendedMetro(own, { sourceExts: ['mjs'] }, fail).resolver.sourceExts, ['js', 'cjs', 'mjs'])
    assert.throws(() => extendedMetro(own, { esm: true, assetExts: ['lottie'] }, fail), { message: "rn.config.json: assetExts is Metro's defaults and lottie, and metro.config.js's resolver.assetExts has riv and lacks lottie: set it in one of them, or alike in both" })
    assert.throws(() => extendedMetro({ ...own, resolver: { ...own.resolver, assetResolutions: ['1', '3'] } }, { assetResolutions: [] }, fail), { message: "rn.config.json: assetResolutions is Metro's defaults, and metro.config.js's resolver.assetResolutions has 3 and lacks 2: set it in one of them, or alike in both" })
    // sourceExts in order, which an import tries them in.
    assert.throws(() => extendedMetro({ ...own, resolver: { ...own.resolver, sourceExts: ['cjs', 'js'] } }, { sourceExts: ['cjs'] }, fail), { message: "rn.config.json: sourceExts is Metro's defaults and cjs, and metro.config.js's resolver.sourceExts has them in another order: set it in one of them, or alike in both" })
    // Of no Metro config loaded (metroConfig false), none to compare.
    assert.deepEqual(extendedMetro(none, { assetExts: ['lottie'] }, fail).assetExts, [...defaults.assetExts, 'lottie'])
  })

  it('refuses an extension it adds to one of assetExts and sourceExts the other has, as it removes none', () => {
    assert.throws(() => extendedMetro(none, { sourceExts: ['svg'] }, fail), { message: 'rn.config.json: sourceExts adds svg, which assetExts has: Metro takes a file of it for an asset, and rn.config.json removes none' })
    assert.throws(() => extendedMetro(loaded, { assetExts: ['cjs'] }, fail), { message: 'rn.config.json: assetExts adds cjs, which sourceExts has: Metro takes a file of it for an asset, and rn.config.json removes none' })
    assert.throws(() => extendedMetro(none, { assetExts: ['glb'], sourceExts: ['glb'] }, fail), { message: /^rn\.config\.json: assetExts adds glb, which sourceExts has/u })
  })
})

describe('flagOf', () => {
  it("is the flag's, else the config's, else off, of what set it", () => {
    assert.deepEqual(flagOf(undefined, {}, 'esm'), { on: false, by: "rn.config.json's esm", flag: false })
    assert.deepEqual(flagOf(undefined, { esm: true }, 'esm'), { on: true, by: "rn.config.json's esm", flag: false })
    assert.deepEqual(flagOf(false, { esm: true }, 'esm'), { on: false, by: '--no-esm', flag: true })
    assert.deepEqual(flagOf(true, {}, 'devtools'), { on: true, by: '--devtools', flag: true })
  })

  it("is a dev build's or a release build's section's, given which, where set there", () => {
    const config = { production: { esm: true } }
    assert.deepEqual(flagOf(undefined, config, 'esm', false), { on: true, by: "rn.config.json's production.esm", flag: false })
    assert.deepEqual(flagOf(undefined, config, 'esm', true), { on: false, by: "rn.config.json's esm", flag: false })
    assert.deepEqual(flagOf(false, config, 'esm', false), { on: false, by: '--no-esm', flag: true })
    assert.deepEqual(flagOf(undefined, { esm: true }, 'esm', true), { on: true, by: "rn.config.json's esm", flag: false })
  })
})

describe('inlineRequires', () => {
  const inlining = { plugin: 'metro-transform-plugins', options: {}, blockList: [] }
  // A Metro config that inlines them, as Metro's defaults set them.
  const metro = { file: 'metro.config.js', inlining: () => Promise.resolve(inlining), ownTransformOptions: false, transformRefusal: () => Promise.resolve(null), inlineRequires: () => Promise.resolve(inlining) }
  const none = { ...metro, inlineRequires: () => Promise.resolve(null) }
  const target = { platform: 'ios', dev: true }
  const of = (given, flag, config) => withInlineRequires(given, (dev) => inlineRequiresOf(flag, config, dev))
  const inlined = (given, flag, config, forTarget = target) => of(given, flag, config).inlineRequires('index.js', forTarget)
  const refusal = (given, flag, config, forTarget = target) => of(given, flag, config).transformRefusal('index.js', forTarget)

  it("is the flag's, else rn.config.json's (its section's where set there), else unset", () => {
    assert.deepEqual(inlineRequiresOf(undefined, {}, true), { on: null, by: "rn.config.json's inlineRequires", flag: false })
    assert.deepEqual(inlineRequiresOf(undefined, { production: { inlineRequires: false } }, false), { on: false, by: "rn.config.json's production.inlineRequires", flag: false })
    assert.deepEqual(inlineRequiresOf(true, { inlineRequires: false }, true), { on: true, by: '--inline-requires', flag: true })
    assert.deepEqual(inlineRequiresOf(false, {}, true), { on: false, by: '--no-inline-requires', flag: true })
  })

  it("leaves the Metro config's where unset, and turns them on or off where set", async () => {
    assert.equal(await inlined(metro, undefined, {}), inlining)
    assert.equal(await inlined(none, undefined, {}), null)
    assert.equal(await inlined(metro, undefined, { inlineRequires: false }), null)
    assert.equal(await inlined(none, undefined, { inlineRequires: true }), inlining)
    assert.equal(await inlined(none, true, {}), inlining)
    assert.equal(await inlined(metro, undefined, { production: { inlineRequires: false } }), inlining)
    // Turned on as the Metro config's other options set them, where it inlines none.
    const own = { ...inlining, options: { ignoredRequires: ['./kept'] } }
    assert.equal(await inlined({ ...none, inlining: () => Promise.resolve(own) }, undefined, { inlineRequires: true }), own)
    for (const config of [{}, { inlineRequires: true }, { inlineRequires: false }]) assert.equal(await refusal(metro, undefined, config), null)
  })

  it('refuses a bundle a Metro config of its own getTransformOptions inlines otherwise, but where the flag sets them', async () => {
    const own = { ...metro, ownTransformOptions: true }
    assert.equal(await refusal(own, undefined, { inlineRequires: false }), "rn.config.json's inlineRequires is false, and metro.config.js's transformer.getTransformOptions gives inlineRequires true: set it in one of them, or alike in both")
    assert.equal(await refusal({ ...own, inlineRequires: () => Promise.resolve(null) }, undefined, { production: { inlineRequires: true } }, { ...target, dev: false }), "rn.config.json's production.inlineRequires is true, and metro.config.js's transformer.getTransformOptions gives inlineRequires false: set it in one of them, or alike in both")
    assert.equal(await refusal(own, undefined, { inlineRequires: true }), null)
    assert.equal(await refusal(own, false, { inlineRequires: true }), null)
    // The Metro config's own refusal first.
    assert.equal(await refusal({ ...own, transformRefusal: () => Promise.resolve('refused') }, undefined, { inlineRequires: false }), 'refused')
  })

  it('refuses a bundle of esm where they are on, naming what sets them; not where they are off', async () => {
    const linking = (config, flag) => (dev) => flagOf(flag, config, 'esm', dev)
    const refusalOf = (given, config, esmFlag, forTarget = target) => withInlineRequires(given, (dev) => inlineRequiresOf(undefined, config, dev), linking(config, esmFlag)).transformRefusal('index.js', forTarget)
    const turnOff = ": turn them off for it (--no-inline-requires, or rn.config.json's inlineRequires false), or leave esm off, the imports checked all the same"
    assert.equal(await refusalOf(metro, { esm: true }), `rn.config.json's esm links ES modules, each run as it is imported, and metro.config.js's transformer.getTransformOptions inlines requires, each module run where first used${turnOff}`)
    assert.equal(await refusalOf({ ...metro, file: null }, {}, true), `--esm links ES modules, each run as it is imported, and React Native's defaults inlines requires, each module run where first used${turnOff}`)
    assert.equal(await refusalOf(none, { inlineRequires: true, esm: true }), `rn.config.json's esm links ES modules, each run as it is imported, and rn.config.json's inlineRequires inlines requires, each module run where first used${turnOff}`)
    for (const [given, config] of [[none, { esm: true }], [metro, { esm: true, inlineRequires: false }], [metro, {}], [metro, { production: { esm: true } }]]) assert.equal(await refusalOf(given, config), null, JSON.stringify(config))
  })

  it('refuses a bundle it inlines the requires of without metro-transform-plugins', async () => {
    const lacking = { ...none, inlining: () => Promise.resolve(null) }
    assert.equal(await refusal(lacking, undefined, { inlineRequires: true }), "rn.config.json's inlineRequires inlines requires with metro-transform-plugins, which the project lacks: npm i -D metro-transform-plugins")
    assert.equal(await refusal(lacking, undefined, { inlineRequires: false }), null)
  })
})

describe('babel, development and production', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' } })
  after(cleanup)
  const read = (config) => {
    writeFileSync(join(root, 'rn.config.json'), JSON.stringify(config))
    return readRnConfig(root, fail)
  }

  it('takes Babel plugins by name, each on or off, in order', () => {
    const config = read({ babel: { 'transform-classes': false, './plugins/mark.js': true, '@babel/plugin-transform-react-jsx': false } })
    for (const dev of [true, false]) assert.deepEqual(babelSwitchesOf(config, dev), [['transform-classes', false], ['./plugins/mark.js', true], ['@babel/plugin-transform-react-jsx', false]])
    assert.deepEqual(babelSwitchesOf({}, true), [])
  })

  it("has a dev build's and a release build's options of their sections, each its own", () => {
    const config = read({ maxWorkers: 2, development: { babel: { a: true } }, production: { babel: { b: false }, esm: true } })
    assert.deepEqual([babelSwitchesOf(config, true), babelSwitchesOf(config, false)], [[['a', true]], [['b', false]]])
    assert.deepEqual([inMode(config, true), inMode(config, false)], [{ maxWorkers: 2, babel: { a: true } }, { maxWorkers: 2, babel: { b: false }, esm: true }])
    // One section alone: the other build has none.
    assert.deepEqual(babelSwitchesOf(read({ production: { babel: { b: false } } }), true), [])
  })

  it('refuses a plugin not on or off, a section of other options, and an option set at the top level and in a section', () => {
    for (const babel of [{ a: 'yes' }, { a: null }, { '': true }, ['a'], 'a']) {
      assert.throws(() => read({ babel }), { message: `rn.config.json: babel is an object of Babel plugins, each true (run it on every file) or false (never), not ${JSON.stringify(babel)}` })
    }
    for (const option of ['metroConfig', 'assetExts', 'sourceExts', 'assetResolutions', 'port', 'devtools', 'launch', 'maxWorkers']) {
      assert.throws(() => read({ development: { [option]: true } }), { message: `rn.config.json: no such option development.${option}: it has babel, esm, inlineRequires` })
    }
    assert.throws(() => read({ production: { babel: { a: 1 } } }), { message: /^rn\.config\.json: production\.babel is an object of Babel plugins/u })
    assert.throws(() => read({ production: [] }), { message: 'rn.config.json: production is an object of options (babel, esm, inlineRequires), not []' })
    assert.throws(() => read({ inlineRequires: true, production: { inlineRequires: false } }), { message: 'rn.config.json: inlineRequires is set at the top level and in production: set it at the top level, for both, or in development and production' })
    assert.deepEqual(read({ development: { inlineRequires: false }, production: { inlineRequires: true } }), { development: { inlineRequires: false }, production: { inlineRequires: true } })
    assert.throws(() => read({ babel: { a: true }, development: { babel: { b: true } } }), { message: 'rn.config.json: babel is set at the top level and in development: set it at the top level, for both, or in development and production' })
    assert.throws(() => read({ esm: false, development: { esm: true }, production: { esm: true } }), { message: 'rn.config.json: esm is set at the top level and in development and production: set it at the top level, for both, or in development and production' })
  })
})

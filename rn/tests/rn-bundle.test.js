import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { after, describe, it } from 'node:test'

import { METRO_0_81, METRO_CONFIG, memoized, pkg, png, printed, writeTree } from './fixtures.js'
import { APP, BABEL_APP, BIN, MODERN, OPTIONS, PLATFORM_PLUGIN, POLYFILLS, PRELUDE, linked, listFiles, md5, notInstalled, reactNativeApp, runBundle, templateConfig } from './rn-bundle-app.js'

describe('rn-bundle', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const run = (args) => runBundle(args, { cwd: root })
  const output = (file) => JSON.parse(printed(join(root, file)))
  // The bundle for iOS, its assets in ios-assets, which --minify's is of
  // too: { code, out }.
  const ios = memoized(async () => {
    const r = await run(['--platform=ios', ...OPTIONS, '--assets-dest=ios-assets', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    return { code: readFileSync(join(root, 'ios.js'), 'utf8'), out: output('ios.js') }
  })

  it('minifies with --minify, to a bundle that does the same', async () => {
    const r = await run(['--platform=ios', ...OPTIONS, '--minify', '--output=min.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const plain = await ios()
    assert.deepEqual(output('min.js'), plain.out)
    const min = readFileSync(join(root, 'min.js'), 'utf8')
    assert.ok(min.length < plain.code.length * 0.6, `${min.length} of ${plain.code.length}`)
    assert.ok(min.split('\n').length < plain.code.split('\n').length / 10, `${min.split('\n').length} lines of ${plain.code.split('\n').length}`)
  })

  it('bundles for iOS: its files, the aliases, Flow, the defines, and each asset as Metro builds it', async () => {
    const { out } = await ios()
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.dual, out.optional, out.dev, out.env], ['ios', 'hi', 'flow', 'generic', 'rn', 'none', false, 'production'])
    assert.deepEqual(out.ids.toSorted(), [1, 2, 3])
    const [logo, icon, font] = out.assets
    assert.deepEqual(logo, { __packager_asset: true, httpServerLocation: '/assets/img', width: 20, height: 10, scales: [1, 2, 3], hash: md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'), name: 'logo', type: 'png' })
    assert.deepEqual([icon.width, icon.hash], [8, md5('img/icon.png')])
    assert.deepEqual(font, { __packager_asset: true, httpServerLocation: '/assets/fonts', scales: [1], hash: md5('fonts/Inter.ttf'), name: 'Inter', type: 'ttf' })
    assert.deepEqual(listFiles(join(root, 'ios-assets')), ['assets/fonts/Inter.ttf', 'assets/img/icon.png', 'assets/img/logo.png', 'assets/img/logo@2x.png', 'assets/img/logo@3x.png'])
    assert.deepEqual(readFileSync(join(root, 'ios-assets/assets/img/logo@3x.png')), APP['img/logo@3x.png'])
  })

  it('bundles for Android: its files and its assets, into res/', async () => {
    const r = await run(['--platform=android', ...OPTIONS, '--assets-dest=res', '--output=android.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('android.js')
    assert.equal(out.where, 'android')
    assert.deepEqual([out.assets[1].width, out.assets[1].hash], [9, md5('img/icon.android.png')])
    assert.deepEqual(listFiles(join(root, 'res')), ['drawable-mdpi/img_icon.png', 'drawable-mdpi/img_logo.png', 'drawable-xhdpi/img_logo.png', 'drawable-xxhdpi/img_logo.png', 'raw/fonts_inter.ttf', 'raw/keep.xml'])
  })

  it("puts iOS's png and jpg assets in an asset catalog with --asset-catalog-dest, each an image set, the rest in --assets-dest", async () => {
    // What a build before left, its image sets removed.
    mkdirSync(join(root, 'stage/RNAssets.xcassets/stale.imageset'), { recursive: true })
    writeFileSync(join(root, 'stage/RNAssets.xcassets/stale.imageset/Contents.json'), '{}')
    writeFileSync(join(root, 'stage/RNAssets.xcassets/Contents.json'), '{}')
    const r = await run(['--platform=ios', ...OPTIONS, '--assets-dest=catalog-assets', '--asset-catalog-dest=stage', '--output=catalog.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(output('catalog.js').assets[0].name, 'logo')
    assert.deepEqual(listFiles(join(root, 'stage')), [
      'RNAssets.xcassets/Contents.json',
      'RNAssets.xcassets/img_icon.imageset/Contents.json',
      'RNAssets.xcassets/img_icon.imageset/img_icon.png',
      'RNAssets.xcassets/img_logo.imageset/Contents.json',
      'RNAssets.xcassets/img_logo.imageset/img_logo.png',
      'RNAssets.xcassets/img_logo.imageset/img_logo@2x.png',
      'RNAssets.xcassets/img_logo.imageset/img_logo@3x.png',
    ])
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'stage/RNAssets.xcassets/img_logo.imageset/Contents.json'), 'utf8')), {
      images: [1, 2, 3].map((scale) => ({ filename: `img_logo${scale === 1 ? '' : `@${scale}x`}.png`, idiom: 'universal', scale: `${scale}x` })),
      info: { author: 'xcode', version: 1 },
    })
    assert.deepEqual(readFileSync(join(root, 'stage/RNAssets.xcassets/img_logo.imageset/img_logo@3x.png')), APP['img/logo@3x.png'])
    assert.deepEqual(listFiles(join(root, 'catalog-assets')), ['assets/fonts/Inter.ttf'])
  })

  it('takes --asset-catalog-dest for iOS alone, and the options of a source map with --sourcemap-output alone', async () => {
    for (const [args, message] of [
      [['--platform=android', '--asset-catalog-dest=stage'], /--asset-catalog-dest is for iOS/u],
      [['--platform=ios', '--sourcemap-sources-root=.'], /shape the map of --sourcemap-output: pass it/u],
      [['--platform=ios', '--sourcemap-use-absolute-path'], /shape the map of --sourcemap-output: pass it/u],
    ]) {
      const r = await run([...args, '--output=refused.js', 'index.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, message)
    }
  })

  it('takes a file for Flow by @flow in its leading comments alone', () => {
    const r = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--output=mentions.out.js', 'mentions.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(output('mentions.out.js'), ['@flow', 1])
  })

  it('fails on what it cannot resolve, parse or strip', async () => {
    const noAliases = await run(['--platform=ios', '--output=out.js', 'index.js'])
    assert.equal(noAliases.status, 1)
    assert.match(noAliases.stderr, /Could not resolve "#lib\/greet"[\s\S]*index\.js/u)
    const divergent = await run(['--platform=ios', '--output=out.js', 'divergent/index.js'])
    assert.equal(divergent.status, 1)
    assert.match(divergent.stderr, /esbuild resolved node_modules\/dep\/index\.js where Metro resolves nothing/u)
    const noFlow = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(noFlow.status, 1)
    assert.match(noFlow.stderr, /Can't strip Flow types from lib\/typed\.js: it needs flow-remove-types/u)
    const enumFlow = await run(['--platform=ios', '--output=out.js', 'enum.js'])
    assert.equal(enumFlow.status, 1)
    assert.match(enumFlow.stderr, /Flow syntax flow-remove-types doesn't strip: Unexpected "enum"[\s\S]*lib\/mode\.js:2:7/u)
    const broken = await run(['--platform=ios', '--output=out.js', 'broken.js'])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /Can't strip Flow types from lib\/broken\.js: Unexpected token[\s\S]*lib\/broken\.js:1:14:/u)
    for (const [file, message] of [['none.json', "can't read none.json as JSON"], ['bad-aliases.json', 'bad-aliases.json: "^(" is not a valid regular expression']]) {
      const r = await run(['--platform=ios', `--babel-aliases=${file}`, '--output=out.js', 'index.js'])
      assert.deepEqual([r.status, r.stderr], [1, `rn-bundle: --babel-aliases: ${message}\n`])
    }
    const noPlatform = await run(['--output=out.js', 'index.js'])
    assert.equal(noPlatform.status, 1)
    assert.match(noPlatform.stderr, /--platform is required/u)
  })

  it('builds for release unless --dev, as Metro does, a --define overriding either', async () => {
    const build = async (...args) => {
      const r = await run(['--platform=ios', '--babel-aliases=aliases.json', ...args, '--output=env.js', 'index.js'])
      assert.equal(r.status, 0, r.stderr)
      const { dev, env } = output('env.js')
      return [dev, env]
    }
    assert.deepEqual(await build(), [false, 'production'])
    assert.deepEqual(await build('--dev'), [true, 'development'])
    assert.deepEqual(await build('--dev', '--define=__DEV__=false'), [false, 'development'])
  })
})

describe('rn-bundle, of a project with no Babel config', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const run = (args) => runBundle(['--platform=ios', ...args, '--output=out.js', 'index.js'], { cwd: root })

  it('builds with no Babel, where no @react-native/babel-preset is either', async () => {
    const r = await run(OPTIONS)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))).platform, null)
  })

  it('takes --profile, --self-test, --esm and --unstable-transform-profile only where Babel runs', async () => {
    const refused = async (args) => {
      const { status, stderr } = await run(args)
      return [status, stderr]
    }
    assert.deepEqual(await refused(['--profile']), [1, "rn-bundle: --profile times the plugins of the project's Babel config, and it has none\n"])
    assert.deepEqual(await refused(['--self-test']), [1, "rn-bundle: --self-test builds again with each of the plugins of the project's Babel config, and it has none\n"])
    assert.deepEqual(await refused(['--esm']), [1, "rn-bundle: --esm keeps ES modules through the project's Babel config, and it has none\n"])
    assert.deepEqual(await refused(['--unstable-transform-profile=hermes-stable']), [1, "rn-bundle: --unstable-transform-profile is the profile the project's Babel config builds for, and it has none\n"])
  })
})

describe('rn-bundle, of a project with a .babelrc, or @react-native/babel-preset alone', () => {
  const ENTRY = { 'platform.js': 'console.log(JSON.stringify(__PLATFORM__))\n', 'node_modules/@babel/core': linked('@babel/core') }
  const babelrc = writeTree({ ...ENTRY, '.babelrc': { plugins: [['./platform-plugin.js', { tag: 'babelrc' }]] }, 'platform-plugin.js': PLATFORM_PLUGIN })
  const PRESET = pkg('@react-native/babel-preset', {
    'package.json': { name: '@react-native/babel-preset', main: 'index.js' },
    // With what of the bundle Metro's transformer gives it.
    'index.js': "module.exports = (api, { projectRoot, dev, platform, unstable_transformProfile, enableBabelRuntime, disableImportExportTransform }) => ({ plugins: [[require('./platform-plugin'), { tag: ['preset, for ' + (projectRoot === process.cwd() ? 'the project' : projectRoot), dev, platform, unstable_transformProfile, enableBabelRuntime, disableImportExportTransform].join(' ') }]] })\n",
    'platform-plugin.js': PLATFORM_PLUGIN,
  })
  const preset = writeTree({ ...ENTRY, ...PRESET })
  // Beneath Metro's transformer alone, as pnpm has them: its preset, its
  // @babel/core.
  const transformer = 'node_modules/@react-native/metro-config/node_modules/@react-native/metro-babel-transformer'
  const nested = writeTree({
    'platform.js': ENTRY['platform.js'],
    ...pkg('@react-native/metro-config', { 'package.json': { name: '@react-native/metro-config', main: 'index.js' }, 'index.js': '' }),
    ...pkg('@react-native/metro-config/node_modules/@react-native/metro-babel-transformer', { 'package.json': { name: '@react-native/metro-babel-transformer', main: 'index.js' }, 'index.js': '' }),
    ...Object.fromEntries(Object.entries(PRESET).map(([path, content]) => [`${transformer}/${path}`, content])),
    [`${transformer}/node_modules/@babel/core`]: linked('@babel/core'),
  })
  after(() => {
    babelrc.cleanup()
    preset.cleanup()
    nested.cleanup()
  })
  const platform = async (root, ...args) => {
    const r = await runBundle(['--platform=ios', ...args, '--output=out.js', 'platform.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(printed(join(root, 'out.js')))
  }

  it('runs a .babelrc, which Metro extends', async () => {
    assert.equal(await platform(babelrc.root), 'babelrc')
  })

  it('runs @react-native/babel-preset, for the project, of the bundle, where it has no config, as Metro does', async () => {
    assert.equal(await platform(preset.root), 'preset, for the project false ios default true false')
    assert.equal(await platform(nested.root, '--dev', '--unstable-transform-profile=hermes-stable'), 'preset, for the project true ios hermes-stable true false')
  })
})

describe('rn-bundle with the project\'s own esbuild', () => {
  const { root, cleanup } = writeTree({ ...BABEL_APP, 'node_modules/esbuild': linked('esbuild-0.25') })
  after(cleanup)

  it('builds with it, from 0.25 on', async () => {
    // The aliases are the Babel config's.
    const r = await runBundle(['--platform=ios', ...OPTIONS.filter((option) => !option.startsWith('--babel-aliases')), '--output=ios.js', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\(esbuild 0\.25\.\d+\)/u)
    const out = JSON.parse(printed(join(root, 'ios.js')))
    assert.deepEqual([out.where, out.greet, out.typed, out.dual], ['ios', 'hi', 'flow', 'rn'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
  })

  it('lowers with it before Babel, from 0.25 on', async () => {
    const r = await runBundle(['--platform=ios', '--output=modern.out.js', 'modern.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\(esbuild 0\.25\.\d+\)/u)
    assert.deepEqual(JSON.parse(printed(join(root, 'modern.out.js'))), MODERN)
  })
})

describe('rn-bundle with a Metro config', () => {
  const RIVE = {
    ...APP,
    ...METRO_CONFIG,
    'metro.config.js': [
      "const { getDefaultConfig } = require('@react-native/metro-config')",
      'const defaultConfig = getDefaultConfig(__dirname)',
      'const config = {',
      '  resolver: {',
      "    assetExts: [...defaultConfig.resolver.assetExts, 'riv'],",
      '  },',
      '}',
      "config.resolver.assetExts.push('lottie')",
      'module.exports = config',
      '',
    ].join('\n'),
    'anim.js': "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify([require('./anim/spin.riv'), require('./anim/wave.lottie')].map(getAssetByID)))\n",
    'anim/spin.riv': 'RIVE',
    'anim/spin@2x.riv': 'RIVE@2x',
    'anim/wave.lottie': 'PK',
        'serializer.js': "globalThis.order = []\nconsole.log(JSON.stringify(require('./later.mjs')))\n",
    'later.mjs': "export const later = 'mjs'\n",
    'blocked.js': "console.log(require('./lib/blocked/hidden'))\n",
    'lib/blocked/hidden.js': "module.exports = 'hidden'\n",
    'scripts/polyfill.js': "(globalThis.order ??= []).push('polyfill')\n",
    'scripts/extra.js': "globalThis.order.push('extra')\n",
    'scripts/before.js': "globalThis.order.push('before')\n",
  }
  const { root, cleanup } = writeTree(RIVE)
  after(cleanup)
  const hash = (...contents) => contents.reduce((md5sum, content) => md5sum.update(content), createHash('md5')).digest('hex')
  const bundleWith = (args, entry) => runBundle(['--platform=ios', ...args, '--output=config-out.js', entry], { cwd: root })
  const outputOf = () => JSON.parse(printed(join(root, 'config-out.js')))

  it('loads it as Metro does, by metro-config, running it: the assetExts it adds are assets', async () => {
    const r = await runBundle(['--platform=android', '--assets-dest=res', '--output=anim.js', 'anim.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    const [spin, wave] = JSON.parse(printed(join(root, 'anim.js')))
    assert.deepEqual(spin, { __packager_asset: true, httpServerLocation: '/assets/anim', scales: [1, 2], hash: hash('RIVE', 'RIVE@2x'), name: 'spin', type: 'riv' })
    assert.deepEqual([wave.name, wave.type, wave.hash], ['wave', 'lottie', hash('PK')])
    assert.deepEqual(listFiles(join(root, 'res')), ['raw/anim_spin.riv', 'raw/anim_wave.lottie', 'raw/keep.xml'])
  })

  it('loads --metro-config where given, refusing one not there', async () => {
    const r = await bundleWith(['--metro-config=metro.json'], 'anim.js')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no such Metro config: metro\.json/u)
    writeFileSync(join(root, 'other.config.js'), templateConfig("{ resolver: { assetExts: ['glow'] } }"))
    writeFileSync(join(root, 'anim/halo.glow'), 'GLOW')
    writeFileSync(join(root, 'glow.js'), "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify(getAssetByID(require('./anim/halo.glow')).type))\n")
    const other = await bundleWith(['--metro-config=other.config.js'], 'glow.js')
    assert.equal(other.status, 0, other.stderr)
    assert.equal(outputOf(), 'glow')
  })

  it("takes its polyfills, the modules it runs before the entry, its sourceExts and its blockList, which hides what it matches", async () => {
    writeFileSync(join(root, 'serializer.config.js'), templateConfig([
      '{',
      "  serializer: { getPolyfills: () => [require.resolve('./scripts/polyfill.js')], polyfillModuleNames: [require.resolve('./scripts/extra.js')], getModulesRunBeforeMainModule: () => [require.resolve('./scripts/before.js')] },",
      "  resolver: { sourceExts: [...defaultConfig.resolver.sourceExts ?? ['js', 'json'], 'mjs'], blockList: [/[/\\\\]lib[/\\\\]blocked[/\\\\]/] },",
      '}',
    ].join('\n')))
    const r = await bundleWith(['--metro-config=serializer.config.js'], 'serializer.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(outputOf(), { later: 'mjs' })
    assert.match(readFileSync(join(root, 'config-out.js'), 'utf8'), /"polyfill"\)[\s\S]*"extra"\)[\s\S]*"before"\)/u)
    const blocked = await bundleWith(['--metro-config=serializer.config.js'], 'blocked.js')
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /esbuild resolved lib\/blocked\/hidden\.js where Metro resolves nothing/u)
  })

  it('refuses an option it does not do: a Babel transformer of its own', async () => {
    writeFileSync(join(root, 'svg.config.js'), templateConfig("{ transformer: { babelTransformerPath: require.resolve('./svg-transformer.js') } }"))
    writeFileSync(join(root, 'svg-transformer.js'), 'module.exports = {}\n')
    const r = await bundleWith(['--metro-config=svg.config.js'], 'anim.js')
    assert.deepEqual([r.status, r.stderr], [1, "rn-bundle: svg.config.js: transformer.babelTransformerPath is \"svg-transformer.js\", a Babel transformer of its own, not the project's Babel config as @react-native/metro-babel-transformer runs it: rn-bundle does it as Metro's default alone\n"])
  })

  it("runs its resolveRequest, as Metro does, wrapping Metro's own resolve", async () => {
    writeFileSync(join(root, 'resolve.config.js'), templateConfig([
      '{ resolver: { resolveRequest: (...args) => {',
      '  const [context, moduleName] = args',
      "  if (moduleName === 'stub') return { type: 'empty' }",
      "  const modulePath = require('path').resolve(require('path').dirname(context.originModulePath), moduleName)",
      "  if (moduleName.endsWith('.js') && !require('fs').existsSync(modulePath)) return context.resolveRequest(context, moduleName.replace(/\\.js$/, '.ts'), ...args.slice(2))",
      '  return context.resolveRequest(...args)',
      '} } }',
    ].join('\n')))
    writeFileSync(join(root, 'resolved.js'), "console.log(JSON.stringify([require('./lib/esm.js').esm, require('stub')]))\n")
    writeFileSync(join(root, 'lib/esm.ts'), "export const esm: string = 'ts'\n")
    const r = await bundleWith(['--metro-config=resolve.config.js'], 'resolved.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(outputOf(), ['ts', {}])
  })

  it("takes package exports either way, and transform options by what they are: refusing Metro's transform of import and export", async () => {
    writeFileSync(join(root, 'imports.config.js'), templateConfig("{ resolver: { unstable_enablePackageExports: true }, transformer: { getTransformOptions: async (entries, { platform }) => ({ transform: { inlineRequires: true, experimentalImportSupport: platform === 'ios' } }) } }"))
    const r = await bundleWith(['--metro-config=imports.config.js'], 'anim.js')
    assert.deepEqual([r.status, r.stderr], [1, "rn-bundle: imports.config.js: transformer.getTransformOptions gives experimentalImportSupport true, Metro's own transform of import and export: rn-bundle does it as Metro's default alone\n"])
  })
})

describe('rn-bundle with a Metro config, but no metro-config', () => {
  const { root, cleanup } = writeTree({ ...APP, 'metro.config.js': 'module.exports = {}\n' })
  after(cleanup)

  it('fails, as it is to run it', async () => {
    const r = await runBundle(['--platform=ios', ...OPTIONS, '--output=out.js', 'index.js'], { cwd: root })
    assert.deepEqual([r.status, r.stderr], [1, 'rn-bundle: loading metro.config.js needs metro-config, as react-native has it: npm i -D metro-config\n'])
  })
})

describe("rn-bundle, of a project's rn.config.json", () => {
  const { root, cleanup } = writeTree({
    ...APP,
    ...METRO_CONFIG,
    // A config it refuses, which metroConfig false leaves unread.
    'metro.config.js': templateConfig("{ transformer: { babelTransformerPath: require.resolve('./svg-transformer.js') } }"),
    'svg-transformer.js': 'module.exports = {}\n',
    'glow.config.js': templateConfig("{ resolver: { assetExts: ['glow'] } }"),
    // A config that sets none of the resolver's lists.
    'plain.config.js': templateConfig('{}'),
    'halo.glow': 'GLOW',
    'glow.js': "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify(getAssetByID(require('./halo.glow')).type))\n",
    'spin.riv': 'RIVE',
    'both.js': "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify([require('./halo.glow'), require('./spin.riv')].map((id) => getAssetByID(id).type)))\n",
    'later.mjs': "export const later = 'mjs'\n",
    'mjs.js': "console.log(JSON.stringify(require('./later')))\n",
    // Of a scale Metro's assetResolutions has none of.
    'tiny@0.75x.png': png(3, 3),
    'tiny.js': "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconst { scales, width } = getAssetByID(require('./tiny.png'))\nconsole.log(JSON.stringify({ scales, width }))\n",
  })
  after(cleanup)
  const outputOf = () => JSON.parse(printed(join(root, 'out.js')))
  const bundleWith = (config, args = [], entry = 'index.js') => {
    writeFileSync(join(root, 'rn.config.json'), JSON.stringify(config))
    return runBundle(['--platform=ios', ...OPTIONS, ...args, '--output=out.js', entry], { cwd: root })
  }

  it('loads the Metro config Metro finds, as of none', async () => {
    const r = await bundleWith({ metroConfig: true })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^rn-bundle: metro\.config\.js: transformer\.babelTransformerPath is "svg-transformer\.js"/u)
  })

  it("loads no Metro config of metroConfig false, as of a project with none: Metro's defaults as @react-native/metro-config has them", async () => {
    const r = await bundleWith({ metroConfig: false })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(printed(join(root, 'out.js'))).where, 'ios')
  })

  it('loads the Metro config of its path, --metro-config over it', async () => {
    const r = await bundleWith({ metroConfig: 'glow.config.js' }, [], 'glow.js')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(printed(join(root, 'out.js'))), 'glow')
    const over = await bundleWith({ metroConfig: false }, ['--metro-config=glow.config.js'], 'glow.js')
    assert.equal(over.status, 0, over.stderr)
    const refused = await bundleWith({ metroConfig: 'glow.config.js' }, ['--metro-config=metro.config.js'], 'glow.js')
    assert.match(refused.stderr, /^rn-bundle: metro\.config\.js: transformer\.babelTransformerPath/u)
    assert.match((await bundleWith({ metroConfig: 'none.config.js' })).stderr, /^rn-bundle: no such Metro config: none\.config\.js\n$/u)
  })

  it("hides what is in a __tests__ directory, as Metro's default blockList does, of metroConfig false", async () => {
    writeFileSync(join(root, 'tested.js'), "console.log(require('./__tests__/fixture'))\n")
    mkdirSync(join(root, '__tests__'), { recursive: true })
    writeFileSync(join(root, '__tests__/fixture.js'), "module.exports = 'fixture'\n")
    const r = await bundleWith({ metroConfig: false }, [], 'tested.js')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /esbuild resolved __tests__\/fixture\.js where Metro resolves nothing/u)
  })

  it('takes esm where Babel runs, as --esm, --no-esm over it', async () => {
    const r = await bundleWith({ metroConfig: false, esm: true })
    assert.deepEqual([r.status, r.stderr], [1, "rn-bundle: rn.config.json's esm keeps ES modules through the project's Babel config, and it has none\n"])
    const over = await bundleWith({ metroConfig: false, esm: true }, ['--no-esm'])
    assert.equal(over.status, 0, over.stderr)
  })

  it("adds its assetExts to Metro's defaults, of a Metro config or none, refusing one that sets them too", async () => {
    const r = await bundleWith({ metroConfig: false, assetExts: ['glow'] }, [], 'glow.js')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(outputOf(), 'glow')
    const both = await bundleWith({ metroConfig: 'plain.config.js', assetExts: ['glow', 'riv'] }, [], 'both.js')
    assert.equal(both.status, 0, both.stderr)
    assert.deepEqual(outputOf(), ['glow', 'riv'])
    const refused = await bundleWith({ metroConfig: 'glow.config.js', assetExts: ['riv'] }, [], 'both.js')
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /^rn-bundle: rn\.config\.json: assetExts is Metro's defaults and riv, and glow\.config\.js's resolver\.assetExts has glow and lacks bmp, gif, jpg, jpeg, png and \d+ more: set it in one of them, or alike in both\n$/u)
    // Set alike in both: Metro's defaults and glow.
    writeFileSync(join(root, 'alike.config.js'), templateConfig("{ resolver: { assetExts: [...defaultConfig.resolver.assetExts, 'glow'] } }"))
    const alike = await bundleWith({ metroConfig: 'alike.config.js', assetExts: ['glow'] }, [], 'glow.js')
    assert.equal(alike.status, 0, alike.stderr)
    assert.equal(outputOf(), 'glow')
    // Of neither, no asset: the file a module.
    assert.equal((await bundleWith({ metroConfig: false }, [], 'glow.js')).status, 0)
    assert.doesNotMatch(readFileSync(join(root, 'out.js'), 'utf8'), /metro-asset:halo\.glow/u)
  })

  it('adds its sourceExts, which an import resolves by, after the others', async () => {
    const r = await bundleWith({ metroConfig: false, sourceExts: ['mjs'] }, [], 'mjs.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(outputOf(), { later: 'mjs' })
    assert.equal((await bundleWith({ metroConfig: false }, [], 'mjs.js')).status, 1)
  })

  it('adds its assetResolutions, the scales an import of an asset resolves its files of', async () => {
    const r = await bundleWith({ metroConfig: false, assetResolutions: [0.75] }, ['--assets-dest=res'], 'tiny.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(outputOf(), { scales: [0.75], width: 4 })
    assert.deepEqual(listFiles(join(root, 'res')), ['assets/tiny@0.75x.png'])
    assert.equal((await bundleWith({ metroConfig: false }, [], 'tiny.js')).status, 1)
  })

  it('refuses an extension it adds to one of assetExts and sourceExts the other has', async () => {
    const r = await bundleWith({ metroConfig: false, sourceExts: ['svg'] })
    assert.deepEqual([r.status, r.stderr], [1, 'rn-bundle: rn.config.json: sourceExts adds svg, which assetExts has: Metro takes a file of it for an asset, and rn.config.json removes none\n'])
  })

  it('refuses an option it does not know, and takes devtools, which is of rn-serve', async () => {
    const r = await bundleWith({ metroConfig: false, esModules: true })
    assert.deepEqual([r.status, r.stderr], [1, 'rn-bundle: rn.config.json: no such option esModules: it has metroConfig, assetExts, sourceExts, assetResolutions, maxWorkers, esm, babel, devtools, port, launch, ios, development, production\n'])
    assert.equal((await bundleWith({ metroConfig: false, devtools: true })).status, 0)
  })
})

describe("rn-bundle, of rn.config.json's metroConfig false, of a Metro whose default reads no package's exports", () => {
  const { root, cleanup } = writeTree({
    ...APP,
    ...METRO_0_81,
    // A subpath its package's exports alone have.
    'node_modules/sub/package.json': { name: 'sub', exports: { './feature': './lib/feature.js' } },
    'node_modules/sub/lib/feature.js': "module.exports = 'feature'\n",
    'exported.js': "console.log(JSON.stringify(require('sub/feature')))\n",
  })
  after(cleanup)
  const run = () => runBundle(['--platform=ios', ...OPTIONS, '--output=out.js', 'exported.js'], { cwd: root })

  it("reads a package's exports, which Metro's default, of no config, does not", async () => {
    const before = await run()
    assert.equal(before.status, 1)
    assert.match(before.stderr, /esbuild resolved node_modules\/sub\/lib\/feature\.js where Metro resolves nothing/u)
    writeFileSync(join(root, 'rn.config.json'), '{ "metroConfig": false }')
    const r = await run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(printed(join(root, 'out.js'))), 'feature')
  })
})

describe('rn-bundle, as @react-native/metro-config configures Metro', () => {
  const modern = writeTree(reactNativeApp(true))
  const older = writeTree(reactNativeApp(false))
  const babel = writeTree({
    ...reactNativeApp(true),
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-flow-strip-types'] }\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  })
  after(() => {
    for (const tree of [modern, older, babel]) tree.cleanup()
  })
  const build = memoized(async (root, args = [], node = []) => {
    const argv = ['--platform=ios', ...args, '--output=out.js', 'index.js']
    // Of Node's own flags, a process of its own.
    const r = node.length === 0 ? await runBundle(argv, { cwd: root }) : spawnSync(process.execPath, [...node, BIN, ...argv], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return { code: readFileSync(join(root, 'out.js'), 'utf8'), out: JSON.parse(printed(join(root, 'out.js'))) }
  })

  it("from react-native 0.87 on: Metro's prelude, the polyfills, react-native/setup-env, then the entry; assets registered with react-native/asset-registry", async () => {
    const { code, out } = await build(modern.root)
    assert.ok(code.startsWith(`${PRELUDE(false)}\n`))
    assert.deepEqual(out, { order: ['console', 'error-guard', 'setup-env'], logo: 'logo', prefix: '', started: 'number' })
    assert.ok((await build(modern.root, ['--dev'])).code.startsWith(`${PRELUDE(true)}\n`))
    assert.ok((await build(modern.root, ['--define=__DEV__=false', '--dev'])).code.startsWith('var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=false,'))
  })

  it("names the main module, the polyfills and the assets by their paths in the project, as esbuild names files: the bundle doesn't depend on where the project is", async () => {
    const { code } = await build(modern.root)
    assert.ok(!code.includes(modern.root), 'no absolute path')
    for (const namespace of ['metro-main', 'metro-polyfill', 'metro-asset']) assert.match(code, new RegExp(`// ${namespace}:[\\w@]`, 'u'))
  })

  it('before react-native 0.87: InitializeCore, and Libraries/Image/AssetRegistry', async () => {
    assert.deepEqual((await build(older.root)).out, { order: ['console', 'error-guard', 'InitializeCore'], logo: 'logo', prefix: '', started: 'number' })
  })

  it('makes the polyfills as it makes any file: through the Babel config, minified', async () => {
    assert.deepEqual((await build(babel.root, ['--minify'], ['--import', notInstalled('flow-remove-types')])).out.order, ['console', 'error-guard', 'setup-env'])
  })
})

describe("rn-bundle, with Metro's inline requires, as @react-native/metro-config has them", () => {
  const APP_FILES = {
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-modules-commonjs'] }\n",
    'index.js': "import { run } from './a'\nimport { version } from 'react'\nconsole.log('index')\nrun(version)\n",
    'a.js': "import { b } from './b'\nimport { unused } from './c'\nconsole.log('a')\nexport const run = (version) => console.log(b, version)\n",
    'b.js': "console.log('b')\nexport const b = 'b'\n",
    'c.js': "console.log('c')\nexport const unused = 'c'\n",
    'node_modules/react/package.json': { name: 'react', main: 'index.js' },
    'node_modules/react/index.js': "console.log('react')\nexports.version = '19'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
  }
  const inlining = writeTree({ ...APP_FILES, ...METRO_CONFIG, 'metro.config.js': "const { getDefaultConfig } = require('@react-native/metro-config')\nmodule.exports = getDefaultConfig(__dirname)\n" })
  // Metro's defaults alone: none inlined.
  const eager = writeTree({ ...APP_FILES, 'node_modules/metro-config': METRO_CONFIG['node_modules/metro-config'] })
  // rn.config.json's metroConfig false: none of Metro's config packages
  // loaded (each throws), the project's Metro's plugin inlining them.
  const never = "throw new Error('never loaded')\n"
  const fromHere = createRequire(import.meta.url)
  const metro = dirname(dirname(fromHere.resolve('metro', { paths: [dirname(fromHere.resolve('metro-config'))] })))
  const unloaded = writeTree({
    ...APP_FILES,
    'rn.config.json': { metroConfig: false },
    'metro.config.js': never,
    'node_modules/metro-config/package.json': { name: 'metro-config', main: 'index.js' },
    'node_modules/metro-config/index.js': never,
    'node_modules/metro': { link: metro },
  })
  after(() => {
    for (const tree of [inlining, eager, unloaded]) tree.cleanup()
  })
  const run = async (root, args = []) => {
    const r = await runBundle(['--platform=ios', ...args, '--output=out.js', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    return printed(join(root, 'out.js')).trim().split('\n')
  }

  it('runs a module where it is first used, as Metro does: not one of nonInlinedRequires (React), nor one never used', async () => {
    assert.deepEqual(await run(inlining.root), ['react', 'index', 'a', 'b', 'b 19'])
    assert.deepEqual(await run(inlining.root, ['--dev']), ['react', 'index', 'a', 'b', 'b 19'])
  })

  it("runs each module as it is imported, where Metro's config inlines none", async () => {
    assert.deepEqual(await run(eager.root), ['b', 'c', 'a', 'react', 'index', 'b 19'])
  })

  it("inlines them as React Native's defaults have it, of rn.config.json's metroConfig false, loading none of Metro's config", async () => {
    assert.deepEqual(await run(unloaded.root), ['react', 'index', 'a', 'b', 'b 19'])
  })
})

describe('rn-bundle --sourcemap-output', () => {
  const plain = writeTree(reactNativeApp(true))
  const babel = writeTree({
    ...reactNativeApp(true),
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-flow-strip-types'] }\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  })
  after(() => {
    plain.cleanup()
    babel.cleanup()
  })
  const build = async (root, args = []) => {
    const r = await runBundle(['--platform=ios', '--sourcemap-output=maps/main.jsbundle.map', ...args, '--output=build/main.jsbundle', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    return { code: readFileSync(join(root, 'build/main.jsbundle'), 'utf8'), map: JSON.parse(readFileSync(join(root, 'maps/main.jsbundle.map'), 'utf8')) }
  }
  // Where the first `text` of the bundle is from: [source, line, column], line from 1.
  const origin = ({ code, map }, text) => {
    const lines = code.split('\n')
    const line = lines.findIndex((each) => each.includes(text))
    const { originalSource, originalLine, originalColumn } = new SourceMap(map).findEntry(line, lines[line].indexOf(text))
    return [originalSource, originalLine + 1, originalColumn]
  }

  it("writes the bundle's map there, as Metro does: each source absolute, those in node_modules on the ignore list; the bundle's sourceMappingURL its name", async () => {
    const { root } = plain
    const bundle = await build(root)
    assert.ok(bundle.code.endsWith('\n//# sourceMappingURL=main.jsbundle.map\n'))
    assert.deepEqual(listFiles(join(root, 'build')), ['main.jsbundle'])
    const { map } = bundle
    assert.equal(map.version, 3)
    assert.deepEqual(map.sources.filter((source) => !source.startsWith(`${root}${sep}`)), ['metro-main:index.js'])
    for (const file of ['index.js', `${POLYFILLS}/console.js`, 'node_modules/react-native/src/setup-env.js', 'img/logo.png']) assert.ok(map.sources.includes(join(root, file)), file)
    assert.deepEqual(map.x_google_ignoreList, map.sources.flatMap((source, i) => (source.includes(`${sep}node_modules${sep}`) ? [i] : [])))
    assert.equal(map.sourcesContent[map.sources.indexOf(join(root, 'index.js'))], reactNativeApp(true)['index.js'])
    assert.deepEqual(origin(bundle, 'order: globalThis.order'), [join(root, 'index.js'), 3, 29])
    assert.deepEqual(printed(join(root, 'build/main.jsbundle')), `${JSON.stringify({ order: ['console', 'error-guard', 'setup-env'], logo: 'logo', prefix: '', started: 'number' })}\n`)
  })

  it('makes each source from --sourcemap-sources-root, and with --sourcemap-use-absolute-path the URL the map\'s path', async () => {
    const { root } = plain
    const { code, map } = await build(root, ['--sourcemap-sources-root=.', '--sourcemap-use-absolute-path'])
    assert.ok(code.endsWith(`\n//# sourceMappingURL=${join(root, 'maps/main.jsbundle.map')}\n`))
    assert.ok(map.sources.includes('index.js') && map.sources.includes(join(POLYFILLS, 'console.js')), String(map.sources))
    assert.ok(map.sources.includes('metro-main:index.js'))
  })

  it('maps through Babel, a polyfill too, and esbuild\'s minifying', async () => {
    const { root } = babel
    const bundle = await build(root, ['--minify'])
    assert.deepEqual(origin(bundle, '"error-guard"'), [join(root, POLYFILLS, 'error-guard.js'), 5, 21])
    assert.deepEqual(origin(bundle, 'JSON.stringify'), [join(root, 'index.js'), 3, 12])
  })
})

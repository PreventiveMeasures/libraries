import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { png, writeTree } from './fixtures.js'

const BIN = fileURLToPath(new URL('../bin/rn-cli.js', import.meta.url))
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .toSorted()

const APP = {
  'index.js': [
    "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'",
    "const { name } = getAssetByID(require('./img/logo.png'))",
    "const babel = typeof __BABEL__ === 'undefined' ? false : __BABEL__",
    'console.log(JSON.stringify({ dev: __DEV__, name, babel }))',
    '',
  ].join('\n'),
  'img/logo.png': png(20, 10),
  'img/logo@2x.png': png(40, 20),
  'metro.config.js': 'module.exports = {}\n',
  'node_modules/react-native/package.json': { name: 'react-native', version: '0.81.0' },
  'node_modules/react-native/Libraries/Image/AssetRegistry.js': 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n',
}

// Each run as Xcode's and Gradle's run it: from the project root.
const runner = (root) => (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })
// rn-bundle's arguments, as --verbose shows them.
const translated = ({ stderr }) => stderr.split('\n').find((line) => line.startsWith('rn-cli: rn-bundle '))?.slice('rn-cli: rn-bundle '.length).split(' ')
const output = (file) => JSON.parse(spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout)

describe('rn-cli bundle', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const run = runner(root)
  const at = (path) => join(root, path)

  it("bundles as Xcode's phase calls `react-native bundle` (react-native-xcode.sh), for Hermes with a source map", () => {
    rmSync(at('xcode'), { recursive: true, force: true })
    const r = run([
      'bundle', '--entry-file', 'index.js', '--platform', 'ios', '--dev', 'false', '--reset-cache',
      '--bundle-output', at('xcode/main.jsbundle'), '--assets-dest', at('xcode/App.app'),
      '--sourcemap-output', at('xcode/main.jsbundle.map'), '--minify', 'false',
      '--config-cmd', `'${process.execPath}' '/nowhere/react-native/cli.js' config`,
    ])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(listFiles(at('xcode')), ['App.app/assets/img/logo.png', 'App.app/assets/img/logo@2x.png', 'main.jsbundle', 'main.jsbundle.map'])
    const code = readFileSync(at('xcode/main.jsbundle'), 'utf8')
    // Not minified: its lines indented, in the iife.
    assert.ok(code.includes('\n  var ') && code.endsWith('\n//# sourceMappingURL=main.jsbundle.map\n'))
    assert.ok(JSON.parse(readFileSync(at('xcode/main.jsbundle.map'), 'utf8')).sources.includes(at('index.js')))
    assert.deepEqual(output(at('xcode/main.jsbundle')), { dev: false, name: 'logo', babel: false })
  })

  it('bundles as the Gradle plugin calls it (BundleHermesCTask), for Android', () => {
    rmSync(at('gradle'), { recursive: true, force: true })
    const r = run([
      'bundle', '--platform', 'android', '--dev', 'false', '--reset-cache', '--entry-file', at('index.js'),
      '--bundle-output', at('gradle/js/index.android.bundle'), '--assets-dest', at('gradle/res'),
      '--sourcemap-output', at('gradle/maps/index.android.bundle.packager.map'), '--config', at('metro.config.js'),
      '--minify', 'false', '--verbose',
    ])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(translated(r), [
      '--platform=android', `--output=${at('gradle/js/index.android.bundle')}`, `--assets-dest=${at('gradle/res')}`,
      `--sourcemap-output=${at('gradle/maps/index.android.bundle.packager.map')}`, `--metro-config=${at('metro.config.js')}`, '--', at('index.js'),
    ])
    assert.deepEqual(listFiles(at('gradle')), ['js/index.android.bundle', 'maps/index.android.bundle.packager.map', 'res/drawable-mdpi/img_logo.png', 'res/drawable-xhdpi/img_logo.png', 'res/raw/keep.xml'])
  })

  it("defaults as Metro does: --dev, minified unless --dev, for iOS; [boolean] options read as commander reads them", () => {
    const args = (...rest) => {
      const r = run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', ...rest, '--verbose'])
      assert.equal(r.status, 0, r.stderr)
      return translated(r).slice(0, -2)
    }
    assert.deepEqual(args(), ['--platform=ios', '--output=out/main.jsbundle', '--dev'])
    assert.deepEqual(args('--dev', 'false'), ['--platform=ios', '--output=out/main.jsbundle', '--minify'])
    assert.deepEqual(args('--dev=false', '--minify'), ['--platform=ios', '--output=out/main.jsbundle', '--minify'])
    assert.deepEqual(args('--dev', '--minify', 'true'), ['--platform=ios', '--output=out/main.jsbundle', '--dev', '--minify'])
    assert.deepEqual(args('--dev', 'no', '--minify', 'false'), ['--platform=ios', '--output=out/main.jsbundle', '--dev'])
  })

  it('takes the options rn-bundle has no use for, and the source map\'s with --sourcemap-output alone', () => {
    const r = run([
      'bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', '--max-workers', '4', '--read-global-cache',
      '--load-config', '{}', '--bundle-encoding', 'utf8', '--unstable-transform-profile', 'default', '--sourcemap-sources-root', '.',
      '--sourcemap-use-absolute-path', '--verbose',
    ])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(translated(r), ['--platform=ios', '--output=out/main.jsbundle', '--dev', '--', 'index.js'])
    const map = run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', '--sourcemap-output', 'out/main.map', '--sourcemap-sources-root', '.', '--sourcemap-use-absolute-path', '--verbose'])
    assert.equal(map.status, 0, map.stderr)
    assert.deepEqual(translated(map).slice(3, 6), ['--sourcemap-output=out/main.map', '--sourcemap-sources-root=.', '--sourcemap-use-absolute-path'])
  })

  it('puts assets in the asset catalog for iOS, as they go to --assets-dest', () => {
    const catalog = (...rest) => translated(run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', '--asset-catalog-dest', 'stage', ...rest, '--verbose'])).filter((arg) => arg.startsWith('--asset'))
    assert.deepEqual(catalog('--assets-dest', 'out'), ['--assets-dest=out', '--asset-catalog-dest=stage'])
    assert.deepEqual(catalog(), [])
    assert.deepEqual(catalog('--assets-dest', 'out', '--platform', 'android'), ['--assets-dest=out'])
    assert.deepEqual(listFiles(at('stage')), ['RNAssets.xcassets/img_logo.imageset/Contents.json', 'RNAssets.xcassets/img_logo.imageset/img_logo.png', 'RNAssets.xcassets/img_logo.imageset/img_logo@2x.png'])
  })

  it('refuses what rn-bundle cannot do as Metro would, and what is no option of `react-native bundle`', () => {
    const base = ['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/refused.js']
    for (const [args, message] of [
      [[...base, '--transformer', 'custom-transformer.js'], /--transformer: rn-bundle transforms by esbuild/u],
      [[...base, '--resolver-option', 'key=value'], /--resolver-option/u],
      [[...base, '--bundle-encoding', 'utf16le'], /writes utf8 alone/u],
      [[...base, '--unstable-transform-profile', 'hermes-stable'], /default profile alone/u],
      [[...base, '--asset-catalog-dest'], /--asset-catalog-dest needs a directory/u],
      [[...base, '--reset-cache=true'], /--reset-cache takes no value/u],
      [[...base, '--watch'], /no such option --watch/u],
      [[...base, 'extra.js'], /no such argument extra\.js/u],
      [['bundle', '--bundle-output', 'out/refused.js'], /--entry-file is required/u],
      [['bundle', '--entry-file', 'index.js'], /--bundle-output is required/u],
      [['bundle', '--entry-file'], /--entry-file needs a value/u],
      [['start'], /no such command start/u],
    ]) {
      const r = run(args)
      assert.equal(r.status, 1, args.join(' '))
      assert.match(r.stderr, message)
    }
  })

  it("fails as rn-bundle fails, and prints its usage when asked", () => {
    const r = run(['bundle', '--entry-file', 'missing.js', '--bundle-output', 'out/missing.js'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /rn-bundle: esbuild reported 1 error/u)
    for (const args of [[], ['--help'], ['bundle', '--help']]) {
      const help = run(args)
      assert.equal(help.status, 0)
      assert.match(help.stdout, /^usage: rn-cli bundle --entry-file FILE --bundle-output FILE/u)
    }
  })
})

describe('rn-cli bundle, of a project with a Babel config', () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'babel.config.js': "module.exports = { plugins: [({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === '__BABEL__') path.replaceWith(t.booleanLiteral(true)) } } })] }\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const run = runner(root)

  it('runs it, as Metro does, unless --babel false', () => {
    const babel = (...args) => {
      const r = run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', ...args])
      assert.equal(r.status, 0, r.stderr)
      return output(join(root, 'out/main.jsbundle')).babel
    }
    assert.equal(babel(), true)
    assert.equal(babel('--babel', 'false'), false)
    assert.equal(babel('--babel'), true)
  })

  it('refuses a .babelrc alone, which rn-bundle would leave out, unless --babel false', () => {
    rmSync(join(root, 'babel.config.js'))
    writeFileSync(join(root, '.babelrc'), '{}')
    const r = run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /rn-bundle runs a babel\.config\.\*, not \.babelrc/u)
    assert.equal(run(['bundle', '--entry-file', 'index.js', '--bundle-output', 'out/main.jsbundle', '--babel', 'false']).status, 0)
  })
})

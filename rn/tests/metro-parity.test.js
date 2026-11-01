import assert from 'node:assert/strict'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { after, describe, it } from 'node:test'

import { createMetroResolver, defaults } from '../metro-resolver.js'
import { TREE, requestsIn } from './metro-tree.js'
import { shown, writeTree } from './fixtures.js'

// createMetroResolver against metro-resolver itself, given the context
// Metro's DependencyGraph builds, written here apart from the code under test.
const require = createRequire(import.meta.url)
const { resolve: metroResolve } = require('metro-resolver')
const { default: createDefaultContext } = require('metro-resolver/private/createDefaultContext')

const kind = (path) => {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

// Metro's file map's hierarchicalLookup of package.json, breaking on node_modules.
function packageForModule(path) {
  const found = (dir, rel) => ({ rootPath: realpathSync(dir), packageJson: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), packageRelativePath: rel })
  if (kind(path)?.isDirectory() && kind(join(path, 'package.json'))?.isFile()) return found(path, '')
  let start = path
  if (kind(path) === null) {
    while (dirname(start) !== start && kind(dirname(start)) === null) start = dirname(start)
    if (basename(start) === 'node_modules') return null
  }
  for (let dir = dirname(start); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    if (kind(join(dir, 'package.json'))?.isFile()) return found(dir, relative(dir, path))
    if (dirname(dir) === dir) return null
  }
  return null
}

// metro-resolver's resolve as ModuleResolution calls it; a failure is null.
function metro(options) {
  const assetExts = new Set(options.assetExts ?? defaults.assetExts)
  const lookup = (path) => {
    const stat = kind(path)
    return stat === null ? { exists: false } : { exists: true, type: stat.isDirectory() ? 'd' : 'f', realPath: realpathSync(path) }
  }
  return (originModulePath, specifier, { platform = null, isESMImport = false } = {}) => {
    const context = createDefaultContext({
      allowHaste: false,
      assetExts,
      customResolverOptions: {},
      dev: false,
      disableHierarchicalLookup: options.disableHierarchicalLookup ?? false,
      doesFileExist: (path) => kind(path)?.isFile() ?? false,
      extraNodeModules: options.extraNodeModules ?? null,
      fileSystemLookup: lookup,
      getPackage: (path) => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'))
        } catch {
          return null
        }
      },
      getPackageForModule: packageForModule,
      isESMImport,
      mainFields: options.mainFields ?? defaults.mainFields,
      nodeModulesPaths: options.nodeModulesPaths ?? [],
      originModulePath,
      preferNativePlatform: options.preferNativePlatform ?? true,
      resolveAsset: (dirPath, assetName, ext) => {
        const files = [`${dirPath}/${assetName}${ext}`, ...defaults.assetResolutions.map((scale) => `${dirPath}/${assetName}@${scale}x${ext}`)]
          .map((file) => lookup(file))
          .filter((result) => result.exists && result.type === 'f')
          .map((result) => result.realPath)
        return files.length > 0 ? files : null
      },
      resolveHasteModule: () => null,
      resolveHastePackage: () => null,
      resolveRequest: null,
      schemeResolvers: {},
      sourceExts: options.sourceExts ?? defaults.sourceExts,
      unstable_conditionNames: options.conditionNames ?? defaults.conditionNames,
      unstable_conditionsByPlatform: options.conditionsByPlatform ?? defaults.conditionsByPlatform,
      unstable_enablePackageExports: true,
      unstable_incrementalResolution: false,
      unstable_logWarning: () => {},
    }, { name: specifier, data: { key: specifier, asyncType: null, isESMImport, locs: [] } })
    try {
      return metroResolve(context, specifier, platform)
    } catch {
      return null
    }
  }
}

describe('createMetroResolver resolves as metro-resolver does', () => {
  const { root, cleanup } = writeTree(TREE)
  after(cleanup)

  const requests = requestsIn(root)

  // The requests the two resolve apart under `options`.
  const differences = (options) => {
    const ours = createMetroResolver(options)
    const theirs = metro(options)
    return requests
      .map((request) => [request, shown(root, ours(...request)), shown(root, theirs(...request))])
      .filter(([, a, b]) => a !== b)
      .map(([[from, specifier, { platform, isESMImport }], a, b]) => `${platform} ${isESMImport ? 'import' : 'require'} ${specifier} from ${relative(root, from)}: ours ${a}, metro-resolver ${b}`)
  }

  it('with React Native\'s defaults', () => assert.deepEqual(differences({}), []))
  it('with no native files preferred', () => assert.deepEqual(differences({ preferNativePlatform: false }), []))
  it('with Metro\'s own mainFields and conditions', () => assert.deepEqual(differences({ mainFields: ['browser', 'main'], conditionNames: [] }), []))
  it('with other source extensions, a custom asset extension, and no web conditions', () => {
    assert.deepEqual(differences({ sourceExts: ['ts', 'tsx', 'js', 'json', 'cjs'], assetExts: [...defaults.assetExts, 'json'], conditionsByPlatform: {} }), [])
  })
  it('with nodeModulesPaths and extraNodeModules', () => {
    const options = { nodeModulesPaths: [join(root, 'vendor', 'node_modules'), join(root, 'node_modules')], extraNodeModules: { stream: join(root, 'shims', 'stream') } }
    assert.deepEqual(differences(options), [])
    assert.deepEqual(differences({ ...options, disableHierarchicalLookup: true }), [])
  })

  // [label, importer, specifier, expected, request options]
  const PINNED = [
    ['a file with the platform as its only extension is no candidate', 'index.js', './src/u', 'src/u.js'],
    ['a trailing slash asks for a directory', 'index.js', './src/k/', 'src/k/index.js'],
    ['a package whose main module is missing fails', 'index.js', './src/broken', null],
    ['an import naming a scale variant is refused', 'index.js', './src/scale@2x.png', null],
    ['an asset resolves to its files at each scale', 'index.js', './src/scale.png', 'src/scale@2x.png'],
    ['a platform\'s asset file is not the asset', 'index.js', './src/img3.png', null, { platform: 'ios' }],
    ['the importer\'s browser map redirects a bare name', 'index.js', 'buffer', 'src/buffer-shim.js'],
    ['the importer\'s browser map empties a bare name', 'index.js', 'gone', '<empty>'],
    ['the importer\'s browser map renames a bare name', 'index.js', 'other', 'node_modules/pkg/lib/sub.js'],
    ['a browser redirect to an absolute path fails', 'node_modules/brabs/index.js', 'dep', null],
    ['a path redirected to an absolute path is taken as it is', 'node_modules/brabs/index.js', './x', null],
    ['a false entry for the main module keeps it', 'index.js', 'brfalse', 'node_modules/brfalse/buf.js'],
    ['a null redirect takes no later field\'s', 'index.js', 'brnull/a', 'node_modules/brnull/a.js'],
    ['a redirect applies to a platform candidate', 'index.js', 'brpkg/lib/b', 'node_modules/brpkg/lib/b-rn.js', { platform: 'ios' }],
    ['a redirect to false empties a candidate', 'index.js', 'brpkg/lib/c', '<empty>'],
    ['a nested package.json redirects its own files', 'index.js', 'nested/esm/x', 'node_modules/nested/esm/y.js'],
    ['a package found by its link resolves by its real path', 'index.js', 'linked', 'node_modules/.pnpm/linked@1.0.0/node_modules/linked/lib/browser.js'],
    ['a linked package\'s dependency resolves beside its real path', 'node_modules/.pnpm/linked@1.0.0/node_modules/linked/lib/index.js', 'linkdep', 'node_modules/.pnpm/linked@1.0.0/node_modules/linkdep/index.js'],
    ['and not beside its link', 'node_modules/linked/lib/index.js', 'linkdep', null],
    ['a directory named like an asset is a package', 'index.js', 'lodash.zip', 'node_modules/lodash.zip/index.js'],
    ['a builtin name resolves only to a package of that name', 'index.js', 'events', 'node_modules/events/events.js'],
    ['a builtin with nothing installed fails', 'index.js', 'fs', null],
    ['a scheme fails with no scheme resolver', 'index.js', 'metro:runtime', null],
    ['a link to nothing is no package', 'index.js', 'stream', null],
    ['an exports map with a bare target is refused whole, for main', 'index.js', 'expbad', 'node_modules/expbad/main.js'],
    ['a refused exports map falls back to the subpath\'s file', 'index.js', 'expbad/x', 'node_modules/expbad/x.js'],
    ['an exports string not starting ./ is refused', 'index.js', 'expstrbad', 'node_modules/expstrbad/main.js'],
    ['an exports map mixing subpaths and conditions is refused', 'index.js', 'expmixed', 'node_modules/expmixed/main.js'],
    ['a subpath\'s fallback array takes its first item', 'index.js', 'exparr', 'node_modules/exparr/exp.js'],
    ['a root array of strings takes its first ./ string', 'index.js', 'exprootarr', 'node_modules/exprootarr/exp.js'],
    ['a root array with no ./ string is refused', 'index.js', 'exprootbad', 'node_modules/exprootbad/main.js'],
    ['a root array of objects takes its first', 'index.js', 'exprootobj', 'node_modules/exprootobj/exp.js'],
    ['a nested fallback array is refused', 'index.js', 'explegacy', 'node_modules/explegacy/main.js'],
    ['an empty fallback array is refused', 'index.js', 'expempty', 'node_modules/expempty/main.js'],
    ['an empty exports lists nothing', 'index.js', 'expemptyobj', 'node_modules/expemptyobj/main.js'],
    ['an exact null subpath shadows its patterns, and falls back to the file', 'index.js', 'expnull/hidden', 'node_modules/expnull/hidden.js'],
    ['a null pattern target falls back to the file', 'index.js', 'expnull/gone/x', 'node_modules/expnull/gone/x.js'],
    ['the pattern with the longest base wins', 'index.js', 'exppat/feat/x/b', 'node_modules/exppat/fx/b.js'],
    ['between equal bases, the longer pattern wins', 'index.js', 'exppat/t/q.js', 'node_modules/exppat/tj/q.js'],
    ['a two-* pattern serves no subpath', 'index.js', 'exppat/m/x/y', 'node_modules/exppat/m/x/y.js'],
    ['a pattern\'s target is taken as spelled', 'index.js', 'exppat/s/k', 'node_modules/exppat/s/$&-k.js'],
    ['a pattern\'s match is put in as a replacement: a $& in it is the *', 'index.js', 'exppat/s/$&', 'node_modules/exppat/s/$&-*.js'],
    ['an exports target with a . segment is refused', 'index.js', 'expseg/dot', 'node_modules/expseg/dot.js'],
    ['an exports target with a node_modules segment is refused', 'index.js', 'expseg/nm', 'node_modules/expseg/nm.js'],
    ['an exports target with an empty segment is refused', 'index.js', 'expseg/dbl', 'node_modules/expseg/dbl.js'],
    ['a number in exports refuses the map', 'index.js', 'expprim/x', 'node_modules/expprim/x.js'],
    ['a subpath exports doesn\'t list falls back', 'index.js', 'expprim/y', 'node_modules/expprim/y.js'],
    ['an exports that is a number fails', 'index.js', 'expnum', null],
    ['an exports target is taken as it is, a type declaration too', 'index.js', 'exptypes/t', 'node_modules/exptypes/t.d.ts'],
    ['an exports target naming no file falls back to the subpath', 'index.js', 'exptypes/gone', 'node_modules/exptypes/gone/index.js'],
    ['an exports target naming an asset takes its scales', 'index.js', 'expasset/logo', 'node_modules/expasset/logo@2x.png,node_modules/expasset/logo@3x.png'],
    ['an exports target naming an asset no file is falls back to the subpath, not the target', 'index.js', 'expasset/nologo', null],
    ['root conditions take the import branch from an import', 'index.js', 'expcond', 'node_modules/expcond/esm.js', { isESMImport: true }],
    ['nested conditions reduce in turn', 'index.js', 'expnested', 'node_modules/expnested/rn-cjs.js'],
    ['a nested miss falls through to the next condition held', 'index.js', 'expfall', 'node_modules/expfall/d.js'],
    ['a nested miss falls through to the next condition held, on web', 'index.js', 'expfall', 'node_modules/expfall/d.js', { platform: 'web' }],
    ['web takes the browser condition', 'index.js', 'expweb', 'node_modules/expweb/browser.js', { platform: 'web' }],
    ['a package imports itself through its exports', 'node_modules/expself/index.js', 'expself/sub', 'node_modules/expself/lib/sub.js'],
    ['a package importing a path its exports hide falls back', 'node_modules/expself/index.js', 'expself/lib/other', 'node_modules/expself/lib/other.js'],
    ['an imports map with a bare target is refused whole', 'node_modules/bareimp/index.js', '#own', null],
    ['an imports map with a ../ target is refused whole', 'node_modules/upimp/index.js', '#own', null],
    ['an imports array reduces to null, and the map is kept', 'node_modules/arrimp/index.js', '#own', 'node_modules/arrimp/own.js'],
    ['an imports array resolves nowhere', 'node_modules/arrimp/index.js', '#arr', null],
    ['an unchosen node branch does not refuse the map', 'node_modules/condimp/index.js', '#c', 'node_modules/condimp/rn.js'],
    ['an imports target is exact: no extension probing', 'node_modules/depimp/index.js', '#e', null],
    ['an imports target is exact: no directory index', 'node_modules/depimp/index.js', '#d', null],
    ['an exact null imports key shadows its patterns', 'node_modules/patimp/index.js', '#q/hit', null],
    ['a null imports pattern resolves nowhere', 'node_modules/patimp/index.js', '#p/n/c', null],
    ['an empty imports map is refused', 'node_modules/emptyimp/index.js', '#x', null],
    ['an imports map with a key not starting # is refused', 'node_modules/keyimp/index.js', '#a', null],
    ['a boolean in imports refuses the map', 'node_modules/primimp/index.js', '#b', null],
    ['an imports miss falls back to the browser map', 'node_modules/brimp/index.js', '#y', 'node_modules/brimp/y.js'],
    ['an imports miss mapped false is an empty module', 'node_modules/brimp/index.js', '#gone', '<empty>'],
    ['an imports miss falls back to node_modules', 'node_modules/brimp/index.js', '#z', 'node_modules/#z/index.js'],
    ['a package with no imports fails a # specifier, browser map aside', 'node_modules/noimp/index.js', '#dep', null],
    ['a package with no imports fails a # specifier, node_modules aside', 'node_modules/noimp/index.js', '#z', null],
    ['imports come from the package closest to the importer', 'node_modules/scopeimp/sub/index.js', '#s', null],
    ['an imports target naming an asset takes its scales', 'index.js', '#img', 'src/img2@2x.png'],
  ]

  it('as pinned', () => {
    const ours = createMetroResolver()
    const theirs = metro({})
    for (const [label, from, specifier, expected, options = { platform: 'ios' }] of PINNED) {
      assert.equal(shown(root, ours(join(root, from), specifier, options)), expected, `ours: ${label}`)
      assert.equal(shown(root, theirs(join(root, from), specifier, options)), expected, `metro-resolver: ${label}`)
    }
  })
})

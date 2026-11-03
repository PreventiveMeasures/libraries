// rn-bundle (usage in bin/rn-bundle.js): resolves to its exit code, 1 for a usage error, a failed
// build or --self-test differences. It stops the Babel workers it made, and sets NODE_ENV.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assetCatalogFiles, assetsDestFiles } from './assets-dest.js'
import { profileReport, timedBefore } from './babel-worker.js'
import { bundle } from './bundle.js'
import { babelAliases, bigBuild, defines, flowStripper, peers, projectBabel } from './cli.js'
import { diskHost } from './defaults.js'
import { maxWorkersOf, metroOptions } from './metro-options.js'
import { extendedMetro, flagOf, metroConfigOf, readRnConfig } from './rn-config.js'
import { prelude } from './serializer.js'
import { differences } from './self-test.js'
import { metroSourceMap } from './source-map.js'

// Metro's transform profiles, as `react-native bundle --unstable-transform-profile` takes them.
const TRANSFORM_PROFILES = ['default', 'hermes-stable', 'hermes-canary']

// A usage error or failed build, reported as `rn-bundle: <message>`.
class Failed extends Error {}

const fail = (message) => {
  throw new Failed(message)
}

export async function rnBundle(argv, { cwd = process.cwd(), stderr = process.stderr } = {}) {
  const closing = []
  try {
    const { values, entry, selfTest, transformProfile, sourcemap } = argsOf(argv)
    const define = defines(values.dev, values.define, fail)
    const env = values.dev ? 'development' : 'production'
    // Set before Babel's workers start, as `react-native bundle` does: Reanimated 3's plugin
    // reads it, omitting worklets' locations and maps in production.
    process.env.NODE_ENV = env
    const rnConfig = readRnConfig(cwd, fail)
    const esm = flagOf(values.esm, rnConfig, 'esm', 'esm')
    const project = peers(cwd, fail)
    const esbuild = project.peer('esbuild', 'bundling')
    const metro = extendedMetro(await metroOptions(cwd, project, fail, { file: metroConfigOf(values['metro-config'], rnConfig), name: 'rn-bundle', minify: values.minify }), rnConfig, fail)
    const entryPath = resolve(cwd, entry)
    const target = { platform: values.platform, dev: values.dev }
    const transformRefusal = await metro.transformRefusal(entryPath, target)
    if (transformRefusal !== null) fail(transformRefusal)
    const inlineRequires = await metro.inlineRequires(entryPath, target)
    const maxWorkers = maxWorkersOf(values['max-workers'], metro, fail)
    const babelOf = (options) => projectBabel(cwd, project, fail, { sourceMaps: sourcemap !== undefined, transformProfile, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime, maxWorkers, oneBuild: true, ...options })?.({ ...target, inlineRequires }) ?? null
    const babel = babelOf({ profile: values.profile, warm: bigBuild(project) })
    if (babel === null) {
      if (values.profile) fail("--profile times the plugins of the project's Babel config, and it has none")
      if (selfTest) fail("--self-test builds again with each of the plugins of the project's Babel config, and it has none")
      if (esm.on) fail(`${esm.by} keeps ES modules through the project's Babel config, and it has none`)
      if (transformProfile !== 'default') fail("--unstable-transform-profile is the profile the project's Babel config builds for, and it has none")
    } else {
      closing.push(babel.babel.close)
      if (values['babel-aliases'] !== undefined) fail("--babel-aliases maps the imports where no Babel runs: the project's Babel config has its aliases")
    }
    // Reports esbuild's errors as esbuild formats them.
    const build = async (options) => {
      try {
        return await bundle(options)
      } catch (error) {
        if (!Array.isArray(error?.errors)) throw error
        for (const line of await esbuild.formatMessages(error.errors, { kind: 'error' })) stderr.write(line)
        return fail(`esbuild reported ${error.errors.length} error(s)`)
      }
    }
    const options = {
      entry,
      platform: values.platform,
      // Only --self-test may omit --output, and then writes no bundle.
      outfile: values.output ?? 'rn-bundle.js',
      esbuild,
      projectRoot: cwd,
      stripFlow: timedBefore(babel?.profile ?? null, 'flow-remove-types', flowStripper(project, babel !== null)),
      babel: babel?.babel ?? null,
      babelPlugins: babel?.babelPlugins ?? null,
      esm: esm.on,
      assetExts: metro.assetExts,
      resolver: { ...metro.resolver, dev: values.dev },
      blockList: metro.blockList,
      runBeforeMain: metro.runBeforeMain?.(entryPath) ?? null,
      assetRegistryPath: metro.assetRegistryPath,
      define,
      minify: values.minify,
      sourcemap: sourcemap !== undefined,
      prelude: prelude(define.__DEV__, env),
      polyfills: metro.polyfills(values.platform),
      aliases: values['babel-aliases'] === undefined ? null : babelAliases(cwd, values['babel-aliases'], fail),
    }
    // Each module as this build loaded it, for --self-test to compare.
    const ours = selfTest ? new Map() : null
    const result = await build({ ...options, cache: ours })
    for (const line of await esbuild.formatMessages(result.warnings, { kind: 'warning' })) stderr.write(line)
    writeOutputs(cwd, values, result)
    stderr.write(`rn-bundle: ${entry} for ${values.platform}${values.output === undefined ? '' : ` to ${values.output}`} (esbuild ${esbuild.version}), ${result.graph.size} modules, ${result.assets.length} assets\n`)
    if (babel?.profile) stderr.write(profileReport(babel.profile, cwd))
    if (!selfTest) return 0
    const kept = babelOf({ keepPlugins: true })
    closing.push(kept.babel.close)
    const theirs = new Map()
    await build({ ...options, babel: kept.babel, babelPlugins: kept.babelPlugins, keepPlugins: true, cache: theirs })
    return reported(await differences(esbuild, ours, theirs), ours.size, cwd, stderr)
  } catch (error) {
    if (!(error instanceof Failed)) throw error
    stderr.write(`rn-bundle: ${error.message}\n`)
    return 1
  } finally {
    await Promise.all(closing.map((close) => close()))
  }
}

function argsOf(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      platform: { type: 'string' },
      output: { type: 'string' },
      dev: { type: 'boolean', default: false },
      minify: { type: 'boolean', default: false },
      'assets-dest': { type: 'string' },
      'asset-catalog-dest': { type: 'string' },
      'sourcemap-output': { type: 'string' },
      'sourcemap-sources-root': { type: 'string' },
      'sourcemap-use-absolute-path': { type: 'boolean', default: false },
      'metro-config': { type: 'string' },
      esm: { type: 'boolean' },
      profile: { type: 'boolean', default: false },
      'self-test': { type: 'boolean', default: false },
      'unstable-transform-profile': { type: 'string' },
      'max-workers': { type: 'string' },
      define: { type: 'string', multiple: true, default: [] },
      'babel-aliases': { type: 'string' },
    },
  })
  if (positionals.length !== 1) fail('one entry file is required')
  if (values.platform === undefined) fail('--platform is required, e.g. --platform=ios')
  const selfTest = values['self-test']
  if (values.output === undefined && !selfTest) fail('--output is required')
  const transformProfile = values['unstable-transform-profile'] ?? 'default'
  if (!TRANSFORM_PROFILES.includes(transformProfile)) fail(`--unstable-transform-profile is one of ${TRANSFORM_PROFILES.join(', ')}`)
  const sourcemap = values['sourcemap-output']
  if (sourcemap !== undefined && values.output === undefined) fail('--sourcemap-output maps the bundle of --output: pass it')
  if (sourcemap === undefined && (values['sourcemap-sources-root'] !== undefined || values['sourcemap-use-absolute-path'])) fail('--sourcemap-sources-root and --sourcemap-use-absolute-path shape the map of --sourcemap-output: pass it')
  if (values['asset-catalog-dest'] !== undefined && values.platform !== 'ios') fail('--asset-catalog-dest is for iOS')
  return { values, entry: positionals[0], selfTest, transformProfile, sourcemap }
}

function writeOutputs(cwd, values, result) {
  const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  const sourcemap = values['sourcemap-output']
  const outfile = values.output === undefined ? null : resolve(cwd, values.output)
  const sourcesRoot = values['sourcemap-sources-root'] === undefined ? null : resolve(cwd, values['sourcemap-sources-root'])
  const sourceMapUrl = sourcemap === undefined ? null : values['sourcemap-use-absolute-path'] ? resolve(cwd, sourcemap) : basename(sourcemap)
  for (const { path, contents, text } of values.output === undefined ? [] : result.outputFiles) {
    if (sourcemap === undefined) write(path, contents)
    else if (path === outfile) write(path, `${text}//# sourceMappingURL=${sourceMapUrl}\n`)
    else write(resolve(cwd, sourcemap), metroSourceMap(text, { outDir: dirname(outfile), projectRoot: cwd, sourcesRoot }))
  }
  let { assets } = result
  if (values['asset-catalog-dest'] !== undefined) {
    const catalog = resolve(cwd, values['asset-catalog-dest'], 'RNAssets.xcassets')
    // Clears previous builds' image sets, as `react-native bundle` does.
    mkdirSync(catalog, { recursive: true })
    for (const name of readdirSync(catalog)) {
      if (name.endsWith('.imageset')) rmSync(join(catalog, name), { recursive: true, force: true })
    }
    const { files, rest } = assetCatalogFiles(assets)
    for (const { src, dest, contents } of files) write(join(catalog, dest), contents ?? diskHost.readFile(src))
    assets = rest
  }
  if (values['assets-dest'] !== undefined) {
    for (const { src, dest, contents } of assetsDestFiles(assets, values.platform)) write(resolve(cwd, values['assets-dest'], dest), contents ?? diskHost.readFile(src))
  }
}

// Reports --self-test's differences among `size` modules; 1 if any.
function reported(found, size, cwd, stderr) {
  if (found.length === 0) {
    stderr.write(`rn-bundle: --self-test: each of ${size} modules is as Babel makes it with each of the config's plugins\n`)
    return 0
  }
  const cut = (line) => (line.length > 160 ? `${line.slice(0, 160)}...` : line)
  stderr.write(`rn-bundle: --self-test: ${found.length} of ${size} modules differ from Babel's output with each of the config's plugins:\n`)
  for (const { path, line, ours, kept } of found) {
    const name = relative(cwd, path).replaceAll('\\', '/')
    stderr.write(line === null ? `  ${name}: in ${ours === null ? 'that' : 'this'} build alone\n` : `  ${name}:${line}\n    - ${cut(ours)}\n    + ${cut(kept)}\n`)
  }
  return 1
}

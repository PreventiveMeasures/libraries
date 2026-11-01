#!/usr/bin/env node
// rn-cli bundle [the options of `react-native bundle`]
// `react-native bundle` by rn-bundle, for what calls it with Metro's options:
// Xcode's "Bundle React Native code and images" phase (react-native-xcode.sh),
// with `export CLI_PATH=` this file in ios/.xcode.env, and the React Native
// Gradle plugin, with `cliFile = file(` this file `)` in the `react {}` block
// of android/app/build.gradle. Each option as @react-native/community-cli-plugin
// takes it (0.78 to 0.88), as rn-bundle's: --entry-file, --platform (ios),
// --dev [boolean] (true), --minify [boolean] (as not --dev), --bundle-output,
// --assets-dest, --asset-catalog-dest (iOS, with --assets-dest),
// --sourcemap-output, --sourcemap-sources-root and
// --sourcemap-use-absolute-path (with --sourcemap-output), --config (the
// metro.config.js whose assetExts are read). Taken, of no use to rn-bundle,
// which keeps no cache and runs no command: --reset-cache,
// --read-global-cache, --max-workers, --verbose, and react-native's
// scripts/bundle.js's --config-cmd and --load-config; --bundle-encoding,
// utf8 alone. --unstable-transform-profile, rn-bundle's, with --babel, of
// no use without. Refused, as rn-bundle can't do as Metro would:
// --transformer, --resolver-option.
// --babel [boolean], rn-bundle's: as Metro's transformer runs the project's
// Babel config, with --babel where it has a babel.config.*, unless --babel
// false.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { babelConfigOf, failer } from '../src/cli.js'

const RN_BUNDLE = fileURLToPath(new URL('rn-bundle.js', import.meta.url))
const USAGE = 'usage: rn-cli bundle --entry-file FILE --bundle-output FILE [--platform ios] [--dev BOOL] [--minify BOOL] [--assets-dest DIR] [--asset-catalog-dest DIR] [--sourcemap-output FILE] [--sourcemap-sources-root DIR] [--sourcemap-use-absolute-path] [--config FILE] [--babel BOOL]\n'

// How each option takes its value: `value`, the next argument where not
// `=`; `optional`, the next where it is no option; `flag`, none.
const OPTIONS = new Map(Object.entries({
  'entry-file': 'value',
  platform: 'value',
  'bundle-output': 'value',
  dev: 'optional',
  minify: 'optional',
  'assets-dest': 'value',
  'asset-catalog-dest': 'optional',
  'sourcemap-output': 'value',
  'sourcemap-sources-root': 'value',
  'sourcemap-use-absolute-path': 'flag',
  config: 'value',
  babel: 'optional',
  'reset-cache': 'flag',
  'read-global-cache': 'flag',
  verbose: 'flag',
  'max-workers': 'value',
  'config-cmd': 'value',
  'load-config': 'value',
  'bundle-encoding': 'value',
  'unstable-transform-profile': 'value',
  transformer: 'value',
  'resolver-option': 'value',
}))
const BABELRCS = ['.babelrc', '.babelrc.js', '.babelrc.cjs', '.babelrc.mjs', '.babelrc.json']

const fail = failer('rn-cli')

// -> Map<name, string | true>, as commander takes them.
function parse(argv) {
  const values = new Map()
  let at = 0
  while (at < argv.length) {
    const match = /^--([a-z-]+)(?:=(.*))?$/su.exec(argv[at])
    if (match === null) fail(`no such argument ${argv[at]}: \`rn-cli bundle\` takes options alone`)
    const [, name, inline] = match
    const kind = OPTIONS.get(name)
    if (kind === undefined) fail(`no such option --${name}`)
    if (kind === 'flag' && inline !== undefined) fail(`--${name} takes no value`)
    const next = argv[at + 1]
    const takesNext = inline === undefined && next !== undefined && (kind === 'value' || (kind === 'optional' && !next.startsWith('-')))
    if (inline === undefined && kind === 'value' && !takesNext) fail(`--${name} needs a value`)
    values.set(name, inline ?? (takesNext ? next : true))
    at += takesNext ? 2 : 1
  }
  return values
}

// As Metro's [boolean] options read one.
const bool = (value) => value !== 'false'

// rn-bundle's arguments for Metro's options.
function translate(values, cwd) {
  const has = (name) => values.has(name)
  const get = (name) => values.get(name)
  if (has('transformer')) fail('--transformer: rn-bundle transforms by esbuild and the project\'s Babel config alone')
  if (has('resolver-option')) fail('--resolver-option: rn-bundle resolves as Metro does by default alone')
  if (has('bundle-encoding') && !['utf8', 'utf-8'].includes(String(get('bundle-encoding')).toLowerCase())) fail('--bundle-encoding: rn-bundle writes utf8 alone')
  for (const name of ['entry-file', 'bundle-output']) {
    if (!has(name)) fail(`--${name} is required`)
  }
  if (get('asset-catalog-dest') === true) fail('--asset-catalog-dest needs a directory')
  const platform = get('platform') ?? 'ios'
  const dev = has('dev') ? bool(get('dev')) : true
  const args = [`--platform=${platform}`, `--output=${get('bundle-output')}`]
  if (dev) args.push('--dev')
  if (has('minify') ? bool(get('minify')) : !dev) args.push('--minify')
  if (has('assets-dest')) args.push(`--assets-dest=${get('assets-dest')}`)
  // As Metro, which puts assets in the catalog for iOS alone, as it saves them to --assets-dest.
  if (has('asset-catalog-dest') && has('assets-dest') && platform === 'ios') args.push(`--asset-catalog-dest=${get('asset-catalog-dest')}`)
  if (has('sourcemap-output')) {
    args.push(`--sourcemap-output=${get('sourcemap-output')}`)
    if (has('sourcemap-sources-root')) args.push(`--sourcemap-sources-root=${get('sourcemap-sources-root')}`)
    if (has('sourcemap-use-absolute-path')) args.push('--sourcemap-use-absolute-path')
  }
  if (has('config')) args.push(`--metro-config=${resolve(cwd, get('config'))}`)
  if (babel(values, cwd)) args.push('--babel', ...(has('unstable-transform-profile') ? [`--unstable-transform-profile=${get('unstable-transform-profile')}`] : []))
  return [...args, '--', get('entry-file')]
}

// Whether to run the project's Babel config: a .babelrc alone, rn-bundle doesn't.
function babel(values, cwd) {
  if (values.has('babel')) return bool(values.get('babel'))
  if (babelConfigOf(cwd) !== null) return true
  const babelrc = BABELRCS.find((name) => existsSync(resolve(cwd, name)))
  return babelrc === undefined ? false : fail(`rn-bundle runs a babel.config.*, not ${babelrc}: rename it, or pass --babel false to build without it`)
}

const [command, ...argv] = process.argv.slice(2)
if (command === undefined || ['--help', '-h', 'help'].includes(command) || argv.includes('--help')) {
  process.stdout.write(USAGE)
} else if (command === 'bundle') {
  const values = parse(argv)
  const args = translate(values, process.cwd())
  if (values.has('verbose')) process.stderr.write(`rn-cli: rn-bundle ${args.join(' ')}\n`)
  const child = spawnSync(process.execPath, [...process.execArgv, RN_BUNDLE, ...args], { stdio: 'inherit' })
  if (child.error !== undefined) throw child.error
  if (child.signal !== null) fail(`rn-bundle was killed by ${child.signal}`)
  process.exitCode = child.status
} else {
  fail(`no such command ${command}: \`rn-cli bundle\`, as \`react-native bundle\`, alone`)
}

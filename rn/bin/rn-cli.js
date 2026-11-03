#!/usr/bin/env node
// rn-cli bundle [the options of `react-native bundle`]
// `react-native bundle` by rn-bundle, for Xcode (CLI_PATH in ios/.xcode.env) and the React Native Gradle plugin
// (cliFile in android/app/build.gradle): takes @react-native/community-cli-plugin's options (0.78 to 0.88) and runs
// rn-bundle with them. Cache, logging and config-command options are accepted and ignored; a few are refused.

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { failer } from '../src/cli.js'

const RN_BUNDLE = fileURLToPath(new URL('rn-bundle.js', import.meta.url))
const USAGE = 'usage: rn-cli bundle --entry-file FILE --bundle-output FILE [--platform ios] [--dev BOOL] [--minify BOOL] [--assets-dest DIR] [--asset-catalog-dest DIR] [--sourcemap-output FILE] [--sourcemap-sources-root DIR] [--sourcemap-use-absolute-path] [--config FILE] [--max-workers N]\n'

// How each option takes a value: `value`, after `=` or as the next argument; `optional`, the
// next argument unless it is an option; `flag`, none.
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

const fail = failer('rn-cli')

// Parses as commander does, into a Map of each name to its value or true.
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

// As Metro's [boolean] options read a value.
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
  // Metro fills the catalog only for iOS and only while saving to --assets-dest.
  if (has('asset-catalog-dest') && has('assets-dest') && platform === 'ios') args.push(`--asset-catalog-dest=${get('asset-catalog-dest')}`)
  if (has('sourcemap-output')) {
    args.push(`--sourcemap-output=${get('sourcemap-output')}`)
    if (has('sourcemap-sources-root')) args.push(`--sourcemap-sources-root=${get('sourcemap-sources-root')}`)
    if (has('sourcemap-use-absolute-path')) args.push('--sourcemap-use-absolute-path')
  }
  if (has('config')) args.push(`--metro-config=${resolve(cwd, get('config'))}`)
  if (has('max-workers')) args.push(`--max-workers=${get('max-workers')}`)
  // 'default' is rn-bundle's default too, so it isn't passed.
  if (has('unstable-transform-profile') && get('unstable-transform-profile') !== 'default') args.push(`--unstable-transform-profile=${get('unstable-transform-profile')}`)
  return [...args, '--', get('entry-file')]
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

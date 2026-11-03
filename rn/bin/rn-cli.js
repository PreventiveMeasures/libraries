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
const OPTIONS = {
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
}

const fail = failer('rn-cli')

// Parses as commander does: each name to its value, or true.
function parse(argv) {
  const values = new Map()
  for (let at = 0; at < argv.length; at++) {
    const [, name, inline] = /^--([a-z-]+)(?:=(.*))?$/su.exec(argv[at]) ?? []
    if (name === undefined) fail(`no such argument ${argv[at]}: \`rn-cli bundle\` takes options alone`)
    const kind = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : fail(`no such option --${name}`)
    const next = argv[at + 1]
    if (inline !== undefined) {
      if (kind === 'flag') fail(`--${name} takes no value`)
      values.set(name, inline)
    } else if (kind === 'value' || (kind === 'optional' && next !== undefined && !next.startsWith('-'))) {
      if (next === undefined) fail(`--${name} needs a value`)
      values.set(name, next)
      at++
    } else {
      values.set(name, true)
    }
  }
  return values
}

// rn-bundle's arguments for Metro's options.
function translate(values) {
  if (values.has('transformer')) fail('--transformer: rn-bundle transforms by esbuild and the project\'s Babel config alone')
  if (values.has('resolver-option')) fail('--resolver-option: rn-bundle resolves as Metro does by default alone')
  if (values.has('bundle-encoding') && !['utf8', 'utf-8'].includes(values.get('bundle-encoding').toLowerCase())) fail('--bundle-encoding: rn-bundle writes utf8 alone')
  for (const name of ['entry-file', 'bundle-output']) {
    if (!values.has(name)) fail(`--${name} is required`)
  }
  if (values.get('asset-catalog-dest') === true) fail('--asset-catalog-dest needs a directory')
  // As Metro's [boolean] options read a value.
  const bool = (name, otherwise) => (values.has(name) ? values.get(name) !== 'false' : otherwise)
  const platform = values.get('platform') ?? 'ios'
  const dev = bool('dev', true)
  const args = [`--platform=${platform}`, `--output=${values.get('bundle-output')}`]
  // An option rn-bundle takes as is.
  const pass = (name) => {
    if (values.has(name)) args.push(`--${name}=${values.get(name)}`)
  }
  if (dev) args.push('--dev')
  if (bool('minify', !dev)) args.push('--minify')
  pass('assets-dest')
  // Metro fills the catalog only for iOS and only while saving to --assets-dest.
  if (values.has('assets-dest') && platform === 'ios') pass('asset-catalog-dest')
  if (values.has('sourcemap-output')) {
    pass('sourcemap-output')
    pass('sourcemap-sources-root')
    if (values.has('sourcemap-use-absolute-path')) args.push('--sourcemap-use-absolute-path')
  }
  if (values.has('config')) args.push(`--metro-config=${resolve(values.get('config'))}`)
  pass('max-workers')
  // 'default' is rn-bundle's default too.
  if (values.get('unstable-transform-profile') !== 'default') pass('unstable-transform-profile')
  return [...args, '--', values.get('entry-file')]
}

const [command, ...argv] = process.argv.slice(2)
if (command === undefined || ['--help', '-h', 'help'].includes(command) || argv.includes('--help')) {
  process.stdout.write(USAGE)
} else if (command === 'bundle') {
  const values = parse(argv)
  const args = translate(values)
  if (values.has('verbose')) process.stderr.write(`rn-cli: rn-bundle ${args.join(' ')}\n`)
  const child = spawnSync(process.execPath, [...process.execArgv, RN_BUNDLE, ...args], { stdio: 'inherit' })
  if (child.error !== undefined) throw child.error
  if (child.signal !== null) fail(`rn-bundle was killed by ${child.signal}`)
  process.exitCode = child.status
} else {
  fail(`no such command ${command}: \`rn-cli bundle\`, as \`react-native bundle\`, alone`)
}

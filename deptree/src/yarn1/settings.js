// The project's .yarnrc and .npmrc, as far as yarn 1 reads them for an
// install. Two settings are followed as yarn follows them:
//
//  - ignore-engines: by a flag, `--ignore-engines` or
//    `--install.ignore-engines`, where its value is true; or as an option,
//    the .yarnrc's where it has one, else the .npmrc's, where its value is
//    truthy, as yarn reads it: a quoted "false" is;
//  - ignore-platform: by a flag alone; yarn reads the option, and does not
//    act on it.
//
// Of the options, yarn reads each by its name from the .yarnrc, or else
// the .npmrc (config.getOption): those that change the tree are refused
// rather than followed — ignore-optional, production, bin-links, the
// workspaces' switches and the like — and so is yarn-path, which has
// another yarn run; one yarn reads only for where it fetches from, how,
// and what it keeps, or reads for no install at all, as most of npm's,
// is passed over, as the tree is held to the lockfile's integrities
// whatever serves it. A `--` line of .yarnrc is a flag yarn adds to its
// command line, for every command or, with one before a dot, for that one:
// one that does not change the tree is passed over, and any other is
// refused, whichever command it is for.

import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from '../pnpm/npmrc.js'

// Flags passed over, by name: of those yarn 1.22 takes, the ones that do
// not change the tree.
const PASSED = new Set([
  'verbose', 'silent', 'json', 'har', 'emoji', 'no-emoji', 'progress', 'no-progress', 'non-interactive', 'no-node-version-check',
  'offline', 'prefer-offline', 'registry', 'proxy', 'https-proxy', 'network-concurrency', 'network-timeout', 'otp', 'mutex',
  'cache-folder', 'preferred-cache-folder', 'global-folder', 'ignore-scripts', 'scripts-prepend-node-path', 'force',
  'skip-integrity-check', 'check-files', 'no-lockfile', 'pure-lockfile', 'frozen-lockfile', 'audit', 'disable-pnp',
])

// Options yarn reads that change the tree, by name: of all yarn 1.22
// reads by config.getOption, and yarn-path, which it reads first.
const REFUSED = new Set([
  'ignore-optional', 'production', 'bin-links', 'workspaces-experimental', 'workspaces-nohoist-experimental', 'plugnplay-override',
  'yarn-link-file-dependencies', 'enable-meta-folder', 'experimental-pack-script-packages-in-mirror', 'yarn-path', 'yarnPath',
])

// Settings followed, by name.
const FOLLOWED = new Set(['ignore-engines', 'ignore-platform'])

// A flag's command, `*` for every one, and its name; undefined for an
// option.
function flagOf(key) {
  const match = /^--(?:(.*?)\.)?(.*)$/u.exec(key)
  return match === null ? undefined : { command: match[1] ?? '*', name: match[2] }
}

// A setting, flag or option, that is not followed: refused where it may
// change the tree.
function check(key, where) {
  const flag = flagOf(key)
  if (flag === undefined ? REFUSED.has(key) : !PASSED.has(flag.name)) throw new DeptreeError(`${quote(key)} is a setting not supported here: it may change what yarn installs`, where)
}

// .yarnrc as yarn's parser reads it, as far as a line of a key and a value
// goes, each bare or quoted as JSON writes it; anything else is refused.
// Each setting by its key, the last line of a key the one yarn keeps, with
// its value as yarn reads it: a bare true or false, a quoted string, or
// else the text, undefined where there is none.
const TOKEN = /"(?:[^"\\]|\\.)*"|[^\s"]+/gu

function unquote(token, what, where) {
  try {
    return JSON.parse(token)
  } catch {
    throw new DeptreeError(`${what} is not a string as JSON writes it`, where)
  }
}

function readYarnrc(text) {
  const settings = new Map()
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const where = `.yarnrc:${index + 1}`
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^\s/u.test(raw)) throw new DeptreeError('an indented line, which yarn reads into the setting above it, is not supported', where)
    const tokens = line.match(TOKEN) ?? []
    if (tokens.join(' ') !== line.replace(/\s+/gu, ' ') || tokens.length > 2) throw new DeptreeError('expected a setting and its value', where)
    const [rawKey, rawValue] = tokens
    const key = rawKey.startsWith('"') ? unquote(rawKey, 'a setting\'s name', where) : rawKey
    let value = rawValue
    if (rawValue?.startsWith('"')) value = unquote(rawValue, 'a value', where)
    else if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true'
    settings.set(key, { value, quoted: rawValue?.startsWith('"'), where })
  }
  return settings
}

// Whether an ignore-engines option is truthy, as yarn reads it from the
// .yarnrc: a bare true or false, or a quoted string, true unless empty.
function truthy(name, { value, quoted }, where) {
  if (typeof value === 'boolean' || quoted) return Boolean(value)
  throw new DeptreeError(`expected true, false or a quoted string for ${quote(name)}`, where)
}

// What the install follows of the .yarnrc and the .npmrc, either of them
// left out where there is none: { ignoreEngines, ignorePlatform }.
export function readSettings({ yarnrc, npmrc }) {
  const flags = new Set()
  let option
  for (const [key, setting] of yarnrc === undefined ? [] : readYarnrc(yarnrc)) {
    const flag = flagOf(key)
    const name = flag?.name ?? key
    if (!FOLLOWED.has(name)) check(key, setting.where)
    else if (flag === undefined) {
      if (name === 'ignore-engines') option = truthy(name, setting, setting.where)
    } else {
      if (typeof setting.value !== 'boolean' || setting.quoted) throw new DeptreeError(`expected true or false for ${quote(key)}`, setting.where)
      if (setting.value && (flag.command === '*' || flag.command === 'install')) flags.add(name)
    }
  }
  let npmOption
  for (const { key, value, list, line } of npmrc === undefined ? [] : parseNpmrc(npmrc)) {
    const where = `.npmrc:${line}`
    if (!FOLLOWED.has(key)) check(key, where)
    else if (list || (value !== 'true' && value !== 'false')) throw new DeptreeError(`expected true or false for ${quote(key)}`, where)
    else if (key === 'ignore-engines') npmOption = value === 'true'
  }
  return { ignoreEngines: flags.has('ignore-engines') || (option ?? npmOption ?? false), ignorePlatform: flags.has('ignore-platform') }
}

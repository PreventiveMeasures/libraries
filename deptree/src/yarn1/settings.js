// The project's .yarnrc and .npmrc, as far as yarn 1 reads them for an
// install. Two settings are followed as yarn follows them: ignore-engines,
// by a `--ignore-engines` or `--install.ignore-engines` flag that is true,
// or by the option, the .yarnrc's where it has one, else the .npmrc's,
// where truthy as yarn reads it; and ignore-platform, by a flag alone, as
// yarn reads the option and does not act on it.
//
// Of the other options, which yarn reads by name from the .yarnrc, or else
// the .npmrc (config.getOption), those that change the tree are refused
// (REFUSED); one yarn reads only for where it fetches from, how, and what
// it keeps, or for no install at all, as most of npm's, is passed over, as
// the tree is held to the lockfile's integrities whatever serves it. A `--`
// line of .yarnrc is a flag yarn adds to its command line, for every
// command or, with one before a dot, for that one: one that does not change
// the tree is passed over, and any other refused, whichever command it is
// for.

import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from '../npmrc.js'

// yarn 1.22's flags that do not change the tree.
const PASSED = new Set([
  'verbose', 'silent', 'json', 'har', 'emoji', 'no-emoji', 'progress', 'no-progress', 'non-interactive', 'no-node-version-check',
  'offline', 'prefer-offline', 'registry', 'proxy', 'https-proxy', 'network-concurrency', 'network-timeout', 'otp', 'mutex',
  'cache-folder', 'preferred-cache-folder', 'ignore-scripts', 'scripts-prepend-node-path', 'force', 'skip-integrity-check',
  'check-files', 'pure-lockfile', 'frozen-lockfile', 'audit', 'disable-pnp',
])

// Of the options yarn 1.22 reads by config.getOption, those that change the
// tree, and yarn-path, which it reads first and which runs another yarn.
// Where global-folder is the project's directory, as a relative one may be,
// yarn reads no package.json with validate(), which drops a name listed
// twice from all but one of its lists.
const REFUSED = new Set([
  'ignore-optional', 'production', 'bin-links', 'workspaces-experimental', 'workspaces-nohoist-experimental', 'plugnplay-override',
  'yarn-link-file-dependencies', 'enable-meta-folder', 'experimental-pack-script-packages-in-mirror', 'global-folder', 'yarn-path',
  'yarnPath',
])

const FOLLOWED = new Set(['ignore-engines', 'ignore-platform'])

// A flag's command, `*` for every one, and name; undefined for an option.
function flagOf(key) {
  const match = /^--(?:(.*?)\.)?(.*)$/u.exec(key)
  return match === null ? undefined : { command: match[1] ?? '*', name: match[2] }
}

function check(key, where) {
  const flag = flagOf(key)
  if (flag === undefined ? REFUSED.has(key) : !PASSED.has(flag.name)) throw new DeptreeError(`${quote(key)} is a setting not supported here: it may change what yarn installs`, where)
}

// .yarnrc as yarn's parser reads it, as far as a line of a key and a value
// goes, each bare or quoted as JSON writes it. The last line of a key is
// the one yarn keeps; a value but a bare true or false, or a quoted string,
// is undefined.
const TOKEN = /"(?:[^"\\]|\\.)*"|[^\s"]+/gu

function unquote(token, what, where) {
  try {
    return JSON.parse(token)
  } catch {
    throw new DeptreeError(`${what} is not a string as JSON writes it`, where)
  }
}

const BARE = new Map([['true', true], ['false', false]])

function readYarnrc(text) {
  const settings = new Map()
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const where = `.yarnrc:${index + 1}`
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^\s/u.test(raw)) throw new DeptreeError('an indented line, which yarn reads into the setting above it, is not supported', where)
    const tokens = line.match(TOKEN) ?? []
    if (tokens.join(' ') !== line.replace(/\s+/gu, ' ') || tokens.length > 2) throw new DeptreeError('expected a setting and its value', where)
    const [key, value] = tokens.map((token) => (token.startsWith('"') ? unquote(token, 'a setting', where) : token))
    const bare = tokens[1]?.startsWith('"') === false
    settings.set(key, { value: bare ? BARE.get(value) : value, where })
  }
  return settings
}

export function readSettings({ yarnrc, npmrc }) {
  const flags = new Set()
  let option
  for (const [key, setting] of yarnrc === undefined ? [] : readYarnrc(yarnrc)) {
    const flag = flagOf(key)
    const name = flag?.name ?? key
    if (!FOLLOWED.has(name)) check(key, setting.where)
    else if (flag === undefined) {
      // yarn reads the option as truthy or not, a quoted "false" as true.
      if (setting.value === undefined) throw new DeptreeError(`expected true, false or a quoted string for ${quote(key)}`, setting.where)
      if (name === 'ignore-engines') option = Boolean(setting.value)
    } else {
      if (typeof setting.value !== 'boolean') throw new DeptreeError(`expected true or false for ${quote(key)}`, setting.where)
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

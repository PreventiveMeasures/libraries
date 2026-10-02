// The project's .npmrc, as far as `npm ci` reads it. npm hands its settings
// to the install as ini reads them, before it validates them: `bin-links=0`
// links bins, as "0" is truthy, though `npm config get` says false. So a
// setting that can change what npm installs, or whether it does, is read
// here only in a form with one reading, and refused in any other.
//
// Three are followed: legacy-peer-deps, engine-strict and bin-links, each
// true or false. Of the rest that can change the tree, a few are taken at
// their default (DEFAULTS) and the others refused whatever their value
// (REFUSED). Any other setting is about where npm fetches from, how, what
// it prints, or another command, and is passed over: the tree is held to
// the lockfile's integrities whatever serves it.

import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from '../npmrc.js'

const FOLLOWED = { __proto__: null, 'legacy-peer-deps': 'legacyPeerDeps', 'engine-strict': 'engineStrict', 'bin-links': 'binLinks' }

const DEFAULTS = {
  __proto__: null,
  'allow-git': ['all'],
  'allow-directory': ['all'],
  'allow-file': ['all'],
  'allow-remote': ['all'],
  'install-strategy': ['hoisted'],
  'install-links': ['false'],
  force: ['false'],
  'dry-run': ['false'],
  global: ['false'],
  'package-lock-only': ['false'],
  usage: ['false'],
  'include-workspace-root': ['false'],
  // Any other version npm fails on.
  'lockfile-version': ['1', '2', '3'],
}

// omit and the rest leave packages out; os, cpu and libc stand in for the
// host's; the workspace filters leave workspaces out; location, umask,
// prefix and the config files change what npm reads, or how it writes; a
// credential not scoped to a registry, which npm ci fails on; and
// allow-scripts, which npm 11.16 on fails on or reads for bins.
const REFUSED = new Set([
  'omit', 'include', 'production', 'dev', 'only', 'also', 'optional', 'os', 'cpu', 'libc', 'workspace', 'workspaces',
  'location', 'umask', 'prefix', 'globalconfig', 'userconfig', '_auth', '_authToken', '_authtoken', '-authtoken', 'username',
  '_password', 'allow-scripts',
])

// Pairs npm fails on, both set: any two of the save-* among them.
const SAVES = ['save-dev', 'save-optional', 'save-peer', 'save-prod']
const EXCLUSIVE = [
  ['before', 'min-release-age'], ['expect-results', 'expect-result-count'], ['provenance', 'provenance-file'], ['prefer-online', 'prefer-offline'],
  ...SAVES.flatMap((save, i) => SAVES.slice(i + 1).map((other) => [save, other])),
]

// ini unquotes, unescapes and cuts at `;` or `#` a key as it does a value,
// and npm fills a `${VAR}` in either from the environment.
const PLAIN = /^[^"'`;#\\]*$/u
const plain = (text) => PLAIN.test(text) && !text.includes('${')

export function readSettings(text) {
  const settings = { legacyPeerDeps: false, engineStrict: false, binLinks: true }
  const seen = new Set()
  for (const { key, value, list, line } of text === undefined ? [] : parseNpmrc(text)) {
    const where = `.npmrc:${line}`
    if (!plain(key)) throw new DeptreeError(`${quote(key)} is quoted, escaped, commented or taken from the environment, which is not read here`, where)
    seen.add(key)
    if (REFUSED.has(key)) throw new DeptreeError(`${quote(key)} is a setting not supported here: it may change what npm installs`, where)
    const accepted = key in FOLLOWED ? ['true', 'false'] : DEFAULTS[key]
    if (accepted === undefined) continue
    if (list || !accepted.includes(value)) throw new DeptreeError(`expected ${accepted.join(' or ')} for ${quote(key)}`, where)
    if (key in FOLLOWED) settings[FOLLOWED[key]] = value === 'true'
  }
  for (const pair of EXCLUSIVE) {
    if (pair.every((key) => seen.has(key))) throw new DeptreeError(`${quote(pair[0])} and ${quote(pair[1])} are both set, which npm fails on`, '.npmrc')
  }
  return settings
}

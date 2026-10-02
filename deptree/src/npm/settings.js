// The project's .npmrc. npm hands the install its settings as ini reads
// them, before validating them (`bin-links=0` links bins, "0" being
// truthy), so one that can change the tree is read only in a form with one
// reading. The rest only change where and how npm fetches, which the
// lockfile's integrities make moot, or what it prints.

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

// A credential not scoped to a registry fails npm ci; allow-scripts fails
// npm 11.16 on, or picks whose bins it links.
const REFUSED = new Set([
  'omit', 'include', 'production', 'dev', 'only', 'also', 'optional', 'os', 'cpu', 'libc', 'workspace', 'workspaces',
  'location', 'umask', 'prefix', 'globalconfig', 'userconfig', '_auth', '_authToken', '_authtoken', '-authtoken', 'username',
  '_password', 'allow-scripts',
])

// Pairs npm fails on, both set.
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

// The project's .yarnrc and .npmrc, as far as yarn 1 reads them for an
// install: a setting that can change the tree — ignore-optional,
// ignore-engines, ignore-platform, production, flat, modules-folder,
// link-duplicates, bin-links, yarn-path and the like — is refused rather
// than followed, and so is any yarn has no use for that is not known here;
// what only moves where yarn fetches from, how, and what it keeps — the
// registry, credentials, the network, its caches — is passed over, as the
// tree is held to the lockfile's integrities whatever serves it. A `--`
// line of .yarnrc is a flag yarn adds to its command line, read alike.

import { DeptreeError, quote } from '../error.js'
import { parseNpmrc } from '../pnpm/npmrc.js'

// Settings passed over, by name.
const PASSED = new Set([
  'registry', 'always-auth', 'email', 'username', '_auth', '_authToken', '_password', 'strict-ssl', 'cafile', 'ca', 'cert', 'key',
  'proxy', 'https-proxy', 'noproxy', 'user-agent', 'network-timeout', 'network-concurrency', 'child-concurrency', 'cache-folder',
  'preferred-cache-folder', 'global-folder', 'prefix', 'lastUpdateCheck', 'disable-self-update-check', 'yarn-offline-mirror',
  'yarn-offline-mirror-pruning', 'offline-cache-folder', 'save-prefix', 'save-exact', 'ignore-scripts', 'frozen-lockfile',
  'non-interactive', 'prefer-offline', 'offline', 'silent', 'verbose', 'no-progress', 'progress', 'mutex', 'check-files',
  'emoji', 'loglevel', 'fund', 'audit', 'update-notifier', 'unsafe-disable-integrity-migration', 'scripts-prepend-node-path',
  'version-tag-prefix', 'version-git-tag', 'version-commit-hooks', 'version-git-sign', 'version-git-message', 'sign-git-tag',
  'tag-version-prefix', 'git-tag-version', 'commit-hooks', 'message', 'init-version', 'init-license', 'init-author-name',
  'init-author-email', 'init-author-url', 'init.author.name', 'init.author.email', 'init.author.url', 'init.license', 'init.version',
])

// A name as yarn and npm read it: a flag's command dropped, a scope's or a
// registry URL's prefix to a credential or a registry dropped.
function baseOf(key) {
  const flag = /^--(?:[^.]+\.)?(.+)$/u.exec(key)
  const name = flag ? flag[1] : key
  if (/^@[^/:]+:registry$/u.test(name)) return 'registry'
  const credential = /^\/\/[^\s]*?:(_authToken|_auth|_password|username|email|always-auth|certfile|keyfile)$/u.exec(name)
  return credential ? credential[1] === 'certfile' || credential[1] === 'keyfile' ? 'cert' : credential[1] : name
}

function check(key, where) {
  if (!PASSED.has(baseOf(key))) throw new DeptreeError(`${quote(key)} is a setting not supported here: it may change what yarn installs`, where)
}

// .yarnrc as yarn's parser reads it, as far as a line of a key and a value
// goes, each bare or quoted as JSON writes it; anything else is refused.
const TOKEN = /"(?:[^"\\]|\\.)*"|[^\s"]+/gu

export function checkYarnrc(text) {
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const where = `.yarnrc:${index + 1}`
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/^\s/u.test(raw)) throw new DeptreeError('an indented line, which yarn reads into the setting above it, is not supported', where)
    const tokens = line.match(TOKEN) ?? []
    if (tokens.join(' ') !== line.replace(/\s+/gu, ' ') || tokens.length > 2) throw new DeptreeError('expected a setting and its value', where)
    let key = tokens[0]
    if (key.startsWith('"')) {
      try {
        key = JSON.parse(key)
      } catch {
        throw new DeptreeError('a setting\'s name is not a string as JSON writes it', where)
      }
    }
    check(key, where)
  }
}

export function checkNpmrc(text) {
  for (const { key, line } of parseNpmrc(text)) check(key, `.npmrc:${line}`)
}

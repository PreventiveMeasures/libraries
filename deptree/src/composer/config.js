// What composer.json's config says of where and how packages install, read
// once the lockfile reader has held the file to what Composer loads:
// vendor-dir, bin-dir, where Composer proxies the bins, and
// preferred-install, which picks a dist or a clone. Composer reads each
// from the environment and its home's config.json first, neither of which
// is read here, as both are taken to be unset.

import { DeptreeError, quote } from '../error.js'
import { wildcard } from '../matcher.js'
import { isInside } from '../mount.js'

const PREFERENCES = new Set(['dist', 'source', 'auto'])
// PCRE's caseless matching, without its UTF mode: ASCII letters alone.
const lower = (text) => text.replace(/[A-Z]/gu, (char) => char.toLowerCase())

// A directory of the project by plain names alone, which Composer neither
// fills in, as it does `~`, `$`, `%` and `{`, nor reads otherwise on
// another system, as a `\`; a `.` or an empty name is as good as none to
// it, but not a `..`. bin-dir's `{$vendor-dir}` is vendor-dir's, as
// Composer fills it in.
function dirOf(config, key, fallback, vendorDir) {
  const value = Object.hasOwn(config, key) ? config[key] : fallback
  const where = `composer.json: config.${key}`
  if (typeof value !== 'string') throw new DeptreeError('is not a string, which Composer\'s schema refuses', where)
  const text = vendorDir === undefined ? value : value.replaceAll('{$vendor-dir}', vendorDir)
  const dir = text.split('/').filter((name) => name !== '' && name !== '.').join('/')
  if (!/^[\w./-]+$/u.test(text) || text.startsWith('/') || !isInside(dir)) throw new DeptreeError(`${quote(value)} is not supported: only a directory within the project, by plain names, is`, where)
  return dir
}

// `auto` installs a dev version from source, any other from its dist.
const resolve = (preference, pkg) => (preference === 'auto' ? (pkg.stability === 'dev' ? 'source' : 'dist') : preference)

// Each package's preference, by Composer's patterns, `*` any run of
// characters, in either case, the first that matches; for none, `auto`. A
// mapping is merged over the default as Composer merges it, `*` the
// default's dist where it does not set it, a pattern it sets again kept
// where it was, and then `*` moved behind the rest.
function preferenceOf(config) {
  const value = Object.hasOwn(config, 'preferred-install') ? config['preferred-install'] : 'dist'
  const where = 'composer.json: config.preferred-install'
  if (typeof value === 'string') {
    if (!PREFERENCES.has(value)) throw new DeptreeError(`${quote(value)} is none of dist, source and auto`, where)
    return (pkg) => resolve(value, pkg)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeptreeError('is neither a string nor a mapping, which Composer\'s schema refuses', where)
  const merged = new Map([['*', 'dist']])
  for (const [pattern, preference] of Object.entries(value)) {
    if (!PREFERENCES.has(preference)) throw new DeptreeError(`${quote(String(preference))} is none of dist, source and auto`, `${where}[${quote(pattern)}]`)
    merged.set(pattern, preference)
  }
  const any = merged.get('*')
  merged.delete('*')
  merged.set('*', any)
  const patterns = [...merged].map(([pattern, preference]) => ({ matches: wildcard(lower(pattern)), preference }))
  return (pkg) => resolve(patterns.find(({ matches }) => matches(lower(pkg.name)))?.preference ?? 'auto', pkg)
}

export function configOf(composerJson) {
  const root = JSON.parse(composerJson)
  const config = Object.hasOwn(root, 'config') ? root.config : {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new DeptreeError('is not a mapping, which Composer\'s schema refuses', 'composer.json: config')
  const vendorDir = dirOf(config, 'vendor-dir', 'vendor')
  return { vendorDir, binDir: dirOf(config, 'bin-dir', '{$vendor-dir}/bin', vendorDir), preference: preferenceOf(config) }
}

// What composer.json's config says of where and how packages install, read
// once the lockfile reader has held the file to what Composer loads:
// vendor-dir, and preferred-install, which picks a dist or a clone. Composer
// reads either from the environment and its home's config.json first,
// neither of which is read here, as both are taken to be unset.

import { DeptreeError, quote } from '../error.js'
import { isInside } from '../mount.js'

const PREFERENCES = new Set(['dist', 'source', 'auto'])
// PCRE's caseless matching, without its UTF mode: ASCII letters alone.
const lower = (text) => text.replace(/[A-Z]/gu, (char) => char.toLowerCase())

function vendorDirOf(config) {
  if (!Object.hasOwn(config, 'vendor-dir')) return 'vendor'
  const value = config['vendor-dir']
  const where = 'composer.json: config.vendor-dir'
  if (typeof value !== 'string') throw new DeptreeError('is not a string, which Composer\'s schema refuses', where)
  // By plain names alone, which Composer neither fills in, as it does `~`,
  // `$`, `%` and `{`, nor reads otherwise on another system, as a `\`; a
  // `.` or an empty name is as good as none to it, but not a `..`.
  const dir = value.split('/').filter((name) => name !== '' && name !== '.').join('/')
  if (!/^[\w./-]+$/u.test(value) || value.startsWith('/') || !isInside(dir)) throw new DeptreeError(`${quote(value)} is not supported: only a directory within the project, by plain names, is`, where)
  return dir
}

// Each package's preference, by Composer's patterns, `*` any run of
// characters, in either case; for no pattern, a dev version's is source.
function preferenceOf(config) {
  const value = Object.hasOwn(config, 'preferred-install') ? config['preferred-install'] : 'dist'
  const where = 'composer.json: config.preferred-install'
  if (typeof value === 'string') {
    if (!PREFERENCES.has(value)) throw new DeptreeError(`${quote(value)} is none of dist, source and auto`, where)
    return (pkg) => (value === 'auto' ? (pkg.stability === 'dev' ? 'source' : 'dist') : value)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeptreeError('is neither a string nor a mapping, which Composer\'s schema refuses', where)
  const patterns = Object.entries(value).map(([pattern, preference]) => {
    if (!PREFERENCES.has(preference)) throw new DeptreeError(`${quote(String(preference))} is none of dist, source and auto`, `${where}[${quote(pattern)}]`)
    const source = lower(pattern).split('*').map((part) => part.replace(/[$()*+.?[\\\]^{|}]/gu, '\\$&')).join('.*')
    return { regex: new RegExp(`^${source}$`, 'su'), preference }
  })
  return (pkg) => {
    const found = patterns.find(({ regex }) => regex.test(lower(pkg.name)))
    if (found === undefined) return pkg.stability === 'dev' ? 'source' : 'dist'
    return found.preference === 'dist' || (pkg.stability !== 'dev' && found.preference === 'auto') ? 'dist' : 'source'
  }
}

export function configOf(composerJson) {
  const root = JSON.parse(composerJson)
  const config = Object.hasOwn(root, 'config') ? root.config : {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new DeptreeError('is not a mapping, which Composer\'s schema refuses', 'composer.json: config')
  return { vendorDir: vendorDirOf(config), preference: preferenceOf(config) }
}

// The root package.json's devEngines, which npm checks against the host
// before it installs (npm-install-checks' checkDevEngines): each engine a
// dependency, or a sequence of them, one of which has to match; where none
// does, npm fails, unless the last has onFail "warn" or "ignore". npm fails
// too on any field it does not know; and the version of the os, which it
// takes from the kernel, is not known here.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

const ENGINES = new Set(['packageManager', 'runtime', 'cpu', 'libc', 'os'])
const PROPERTIES = new Set(['name', 'version', 'onFail'])
const ON_FAIL = new Set(['ignore', 'warn', 'error', 'download'])

const isMapping = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// Whether `wanted` matches `current`; it throws where npm does.
function matches(wanted, current, at) {
  const fail = (detail) => {
    throw new DeptreeError(`${detail}, which npm fails on`, at)
  }
  if (!isMapping(wanted)) fail('expected a mapping')
  const unknown = Object.keys(wanted).find((key) => !PROPERTIES.has(key))
  if (unknown !== undefined) fail(`${quote(unknown)} is not a field npm knows`)
  if (typeof wanted.name !== 'string') fail('expected a name')
  if (typeof current.name !== 'string') fail('the host has none')
  if ('onFail' in wanted && !ON_FAIL.has(wanted.onFail)) fail(`expected onFail to be one of ${[...ON_FAIL].join(', ')}`)
  if (wanted.name !== current.name) return false
  if (!('version' in wanted)) return true
  if (typeof wanted.version !== 'string') fail('expected a version')
  if (current.version === undefined) {
    if (at.endsWith('.os')) throw new DeptreeError('a version of the os, which npm takes from the kernel, is not known here', at)
    fail('the host has no version of it')
  }
  return validRange(wanted.version) ? satisfies(current.version, wanted.version) : wanted.version === current.version
}

export function checkDevEngines(devEngines, host, at) {
  if (devEngines === undefined) return
  if (!isMapping(devEngines)) throw new DeptreeError('expected a mapping, which npm fails without', at)
  const current = {
    cpu: { name: host.cpu },
    libc: { name: host.libc },
    os: { name: host.os },
    packageManager: { name: 'npm', version: host.npm },
    runtime: { name: 'node', version: `v${host.node}` },
  }
  for (const [engine, wanted] of Object.entries(devEngines)) {
    if (!ENGINES.has(engine)) throw new DeptreeError(`${quote(engine)} is not an engine npm knows, which it fails on`, at)
    const dependencies = [wanted].flat()
    const where = `${at}.${engine}`
    const matched = dependencies.map((dependency) => matches(dependency, current[engine], where)).some(Boolean)
    if (dependencies.length === 0 || matched) continue
    const onFail = dependencies.at(-1).onFail || 'error'
    if (onFail === 'error' || onFail === 'download') throw new DeptreeError(`the host's ${engine} is not one it takes, which npm fails on`, where)
  }
}

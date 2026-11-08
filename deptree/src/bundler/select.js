// The gems `bundle install` installs on a machine, as Bundler 2.5 to 4.0
// materialize them: from DEPENDENCIES on, one of each name.

import { DeptreeError, quote } from '../error.js'
import { bestFor, isLocked, parsePlatform } from './platform.js'

export const about = (key) => `specs[${quote(key)}]`

const platformOf = (text) => (text === 'ruby' ? 'ruby' : parsePlatform(text))

// Bundler resolves anew a lockfile its machine is not among the PLATFORMS
// of; and one of `ruby` alone it reads as before 2.2, taking each gem of
// whatever platform rubygems.org has for the machine.
export function checkPlatforms(lock, machine, shown) {
  const platforms = lock.platforms.map(platformOf)
  if (platforms.every((platform) => platform === 'ruby')) throw new DeptreeError('PLATFORMS has `ruby` alone, for which Bundler takes the platform of each gem from what rubygems.org has, which is not supported')
  if (!isLocked(platforms, machine)) throw new DeptreeError(`none of PLATFORMS is ${quote(shown)}, which Bundler adds and resolves every gem for anew`)
}

// The keys of `lock.specs` installed, in the lockfile's order; a dependency
// with no gem locked is taken to be for platforms not locked.
export function installedSpecs(lock, machine, shown) {
  const chosen = new Set()
  const seen = new Set(['bundler'])
  const queue = Object.keys(lock.dependencies)
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const keys = lock.gems[name]
    if (keys === undefined) continue
    const { best, tied } = bestFor(keys.map((key) => ({ key, platform: platformOf(lock.specs[key].platform) })), machine)
    if (tied !== undefined) throw new DeptreeError(`${tied.map(({ key }) => quote(key)).join(' and ')} are as specific to ${quote(shown)}, of which Bundler installs either or both`, `gems[${quote(name)}]`)
    if (best === undefined) throw new DeptreeError(`no gem of it is of a platform ${quote(shown)} takes, for which Bundler resolves anew`, `gems[${quote(name)}]`)
    chosen.add(best.key)
    queue.push(...Object.keys(lock.specs[best.key].dependencies))
  }
  return Object.keys(lock.specs).filter((key) => chosen.has(key))
}

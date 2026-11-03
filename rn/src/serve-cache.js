// rn-serve's cache directory, and the bundles the project's last run served, built on the next start ahead of
// the app so it gets them at once or joins a build under way. Not in the cache key (load-cache.js's
// ownModules()): nothing here changes what the cache holds.

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { touch } from './load-pack.js'
import { oneBundleOf } from './native-bundles.js'

// At most as many bundles as a dev bundler keeps built.
const KEPT = 8
const uid = process.getuid?.() ?? null

// A directory in the OS's temporary directory, named for this user.
export function usersOwn(name) {
  return join(tmpdir(), uid === null ? name : `${name}-${uid}`)
}

// The cache directory, emptied first if `reset`. null unless it is this user's alone,
// since bundles would run whatever another user put there.
export function cacheDirOf(reset, log) {
  const dir = usersOwn('rn-serve-cache')
  try {
    if (reset) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (uid === null || (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0)) return dir
  } catch {
    // Can't be made.
  }
  log(`rn-serve: keeping no files across runs: ${dir} is not this user's alone`)
  return null
}

// './index for ios', or './index for ios, release, minified'.
export const bundleName = ({ entryFile, platform, dev, minify }) => `${entryFile} for ${platform ?? 'no platform'}${dev ? '' : ', release'}${minify ? ', minified' : ''}`

// A kept bundle as a dev bundler's request (bundle-url.js's bundleRequest()), or null if it is malformed.
const requestOf = (kept) => {
  if (kept === null || typeof kept !== 'object') return null
  const { entryFile, platform, dev, minify } = kept
  if (typeof entryFile !== 'string' || !entryFile.startsWith('./') || !(platform === null || typeof platform === 'string') || typeof dev !== 'boolean' || typeof minify !== 'boolean') return null
  return { kind: 'bundle', entryFile, platform, dev, minify, shallow: false }
}

// served(devBundler) wraps it to record each non-shallow request of this run, replacing the last run's.
// warm() builds the last run's bundles one after another; without any, the project's one bundle for
// `launched`, else iOS on a Mac (`system`), else Android. Read and write failures are ignored.
export function lastBuilds(dir, projectRoot, { system = process.platform, launched = null } = {}) {
  const path = join(dir, 'builds', `${createHash('sha256').update(projectRoot).digest('hex')}.json`)
  let last = []
  try {
    last = JSON.parse(readFileSync(path, 'utf8')).map(requestOf).filter((request) => request !== null)
    // Keeps load-prune.js from removing it as unused.
    touch(path)
  } catch {
    // None kept.
  }
  const run = new Map()
  const asked = ({ shallow, entryFile, platform, dev, minify }) => {
    const key = JSON.stringify([entryFile, platform, dev, minify])
    if (shallow || run.has(key) || run.size >= KEPT) return
    run.set(key, { entryFile, platform, dev, minify })
    const temp = `${path}.${process.pid}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temp, JSON.stringify([...run.values()]))
      renameSync(temp, path)
    } catch {
      try {
        rmSync(temp, { force: true })
      } catch {}
    }
  }
  return {
    served: (devBundler) => ({
      ...devBundler,
      get: (request, options) => {
        asked(request)
        return devBundler.get(request, options)
      },
    }),
    async warm(devBundler, log) {
      const requests = last.length > 0 ? last : [oneBundleOf(projectRoot, launched ?? (system === 'darwin' ? 'ios' : 'android')).request].filter((request) => request !== null)
      if (requests.length > 0) log(`rn-serve: building ${requests.map(bundleName).join('; ')}`)
      for (const request of requests) await devBundler.get(request).catch(() => {})
    },
  }
}

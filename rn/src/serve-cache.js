// rn-serve's cache: its directory, the user's own, in the OS's temporary
// directory; and the bundles an app asked a project's rn-serve for, of its
// last run that served one (each by its entry, platform, dev and minify, as
// a dev bundler keys a build), built as a run after starts, ahead of the
// app, which then has its bundle at once, or joins its build as it goes:
// the cache read then, not as the app first asks. Not of the chain
// (load-cache.js's ownModules()): what it keeps is of no key of the cache's.

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { touch } from './load-pack.js'
import { oneBundleOf } from './native-bundles.js'

// A run's bundles kept, at most: a dev bundler's.
const KEPT = 8

// A directory of the OS's temporary directory, of the user's by its name.
export function usersOwn(name) {
  const uid = process.getuid?.() ?? null
  return join(tmpdir(), uid === null ? name : `${name}-${uid}`)
}

// The directory each file as it loads is kept in across runs: the user's
// own, in the OS's temporary directory, as Metro keeps its cache; emptied
// first with `reset` (--reset-cache). null, none kept, where it is another
// user's, or another may write in it: the bundles would run what they put
// there.
export function cacheDirOf(reset, log) {
  const uid = process.getuid?.() ?? null
  const dir = usersOwn('rn-serve-cache')
  try {
    if (reset) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (uid === null || (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0)) return dir
  } catch {
    // Not there, and can't be made.
  }
  log(`rn-serve: keeping no files across runs: ${dir} is not this user's alone`)
  return null
}

// A bundle request by its entry, platform, dev and minify: './index for ios',
// but a release's or a minified one's: './index for ios, release, minified'.
export const bundleName = ({ entryFile, platform, dev, minify }) => `${entryFile} for ${platform ?? 'no platform'}${dev ? '' : ', release'}${minify ? ', minified' : ''}`
const keyOf = ({ entryFile, platform, dev, minify }) => JSON.stringify([entryFile, platform, dev, minify])
// A request as a dev bundler takes it (bundle-url.js's bundleRequest()), of
// the fields kept; null of one that is none.
const requestOf = (kept) => {
  if (kept === null || typeof kept !== 'object') return null
  const { entryFile, platform, dev, minify } = kept
  if (typeof entryFile !== 'string' || !entryFile.startsWith('./') || !(platform === null || typeof platform === 'string') || typeof dev !== 'boolean' || typeof minify !== 'boolean') return null
  return { kind: 'bundle', entryFile, platform, dev, minify, shallow: false }
}

// -> { served(devBundler), warm(devBundler, log) }, of the project at
// `projectRoot`, kept in `dir` (rn-serve's cache). served() -> the dev
// bundler, of which each request (but a shallow one, a module's) is the
// run's, kept as an app first makes it, the last run's then gone. warm()
// -> a promise of the last run's built, one after another, in the order
// an app first asked for them; of none kept, the project's one bundle
// (native-bundles.js's oneBundleOf()), for `launched` (the platform of the
// app rn-serve launches), else for iOS on a Mac (`system`, process.platform's), else for
// Android, where it has one. A cache's, at best: what fails to read or write
// is none.
export function lastBuilds(dir, projectRoot, { system = process.platform, launched = null } = {}) {
  const path = join(dir, 'builds', `${createHash('sha256').update(projectRoot).digest('hex')}.json`)
  let last = []
  try {
    last = JSON.parse(readFileSync(path, 'utf8')).map(requestOf).filter((request) => request !== null)
    // Used: of a week no run has, load-prune.js's prune() removes it.
    touch(path)
  } catch {
    // None kept.
  }
  const run = new Map()
  const write = () => {
    const written = `${path}.${process.pid}`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(written, JSON.stringify([...run.values()]))
      renameSync(written, path)
    } catch {
      try {
        rmSync(written, { force: true })
      } catch {}
    }
  }
  const asked = (request) => {
    if (request.shallow || run.has(keyOf(request)) || run.size >= KEPT) return
    const { entryFile, platform, dev, minify } = request
    run.set(keyOf(request), { entryFile, platform, dev, minify })
    write()
  }
  return {
    served: (devBundler) => ({
      ...devBundler,
      get: (request, options) => {
        asked(request)
        return devBundler.get(request, options)
      },
    }),
    warm: (devBundler, log) => {
      let requests = last
      if (requests.length > 0) log(`rn-serve: building ${requests.map(bundleName).join('; ')}`)
      else {
        const { request } = oneBundleOf(projectRoot, launched ?? (system === 'darwin' ? 'ios' : 'android'))
        if (request !== null) log(`rn-serve: building ${bundleName(request)}`)
        requests = request === null ? [] : [request]
      }
      return requests.reduce((done, request) => done.then(() => devBundler.get(request).catch(() => {})), Promise.resolve())
    },
  }
}

// rn-serve's cache directory, and the bundles the project's last run served, built on the next start ahead of
// the app so it gets them at once or joins a build under way. Not in the cache key (load-cache.js's
// ownModules()): nothing here changes what the cache holds.

import { createHash } from 'node:crypto'
import { globSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { touch } from './load-pack.js'

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

// A dev bundler's request (bundle-url.js's bundleRequest()) of a bundle.
const requestOf = ({ entryFile, platform, dev, minify }) => ({ kind: 'bundle', entryFile, platform, dev, minify, shallow: false })
// Whether a kept bundle is one to build: well-formed, its entry in the project.
const isKept = (kept) => typeof kept?.entryFile === 'string' && kept.entryFile.startsWith('./') && (kept.platform === null || typeof kept.platform === 'string') && typeof kept.dev === 'boolean' && typeof kept.minify === 'boolean'

// served(devBundler) wraps it to record each non-shallow request of this run, replacing the last run's.
// warm() builds the last run's bundles one after another; without any, the project's one bundle for
// `launched`, else iOS on a Mac (`system`), else Android. Read and write failures are ignored.
export function lastBuilds(dir, projectRoot, { system = process.platform, launched = null } = {}) {
  const path = join(dir, 'builds', `${createHash('sha256').update(projectRoot).digest('hex')}.json`)
  let last = []
  try {
    last = JSON.parse(readFileSync(path, 'utf8')).filter(isKept).map(requestOf)
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
      let requests = last
      if (requests.length === 0) {
        const platform = launched ?? (system === 'darwin' ? 'ios' : 'android')
        const entries = entriesOf(projectRoot, platform)
        requests = entries.length === 1 ? [requestOf({ entryFile: entries[0], platform, dev: true, minify: false })] : []
      }
      if (requests.length > 0) log(`rn-serve: building ${requests.map(bundleName).join('; ')}`)
      for (const request of requests) await devBundler.get(request).catch(() => {})
    },
  }
}

// Where a native project names its bundles: the iOS AppDelegate's bundle root, or the Android MainApplication's
// getJSMainModuleName() or jsMainModulePath ("index" if unnamed, as React Native's DefaultReactHost has it).
const NATIVE = {
  ios: { dir: ['ios'], depth: 3, files: 'AppDelegate.{swift,mm,m}', roots: [/BundleRoot:\s*@?"([^"]+)"/gu], unnamed: [] },
  android: { dir: ['android', 'app', 'src', 'main'], depth: 8, files: 'MainApplication.{kt,java}', roots: [/jsMainModulePath\s*=\s*"([^"]+)"/gu, /getJSMainModuleName\(\)[^"]*?"([^"]+)"/gu], unnamed: ['index'] },
}
// Directories that hold none of the project's own native code; hidden ones, which globs skip, neither.
const SKIPPED = ['**/Pods', '**/build', '**/node_modules']

// The entries ('./index') of the project's bundles for `platform` that it has a file of, as its native project
// names them; without a native project, or one naming none, its index.
export function entriesOf(projectRoot, platform) {
  const { dir, depth, files, roots, unnamed } = NATIVE[platform]
  const native = join(projectRoot, ...dir)
  // Down to `depth` directories.
  const patterns = Array.from({ length: depth + 1 }, (_, n) => `${'*/'.repeat(n)}${files}`)
  const named = new Set()
  for (const path of globSync(patterns, { cwd: native, exclude: SKIPPED })) {
    let code
    try {
      code = readFileSync(join(native, path), 'utf8')
    } catch {
      continue
    }
    const found = roots.flatMap((pattern) => Array.from(code.matchAll(pattern), (match) => match[1]))
    for (const root of found.length > 0 ? found : unnamed) named.add(root.replace(/^\.?\//u, ''))
  }
  if (named.size === 0) named.add('index')
  return [...named].filter((root) => exists(projectRoot, root)).map((root) => `./${root}`)
}

// Whether the project has a file for the bundle root with any extension: index.js, index.ios.tsx.
function exists(projectRoot, root) {
  try {
    return readdirSync(join(projectRoot, dirname(root))).some((name) => name.startsWith(`${basename(root)}.`))
  } catch {
    return false
  }
}

// The bundles a project's app asks for, as its native project names them:
// of iOS, its AppDelegate's bundle root (React Native's template's
// jsBundleURL(forBundleRoot: "index"), or Objective-C's
// jsBundleURLForBundleRoot:@"index"); of Android, its MainApplication's
// (getJSMainModuleName(), or getDefaultReactHost()'s jsMainModulePath,
// "index" where it names none, as React Native's DefaultReactHost has it).
// Of a project of no native project, or one that names none, its index
// (an index.js, index.ts, index.ios.js...), where it has one.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Directories none of a project's own native code is in.
const SKIPPED = new Set(['Pods', 'build', 'node_modules'])
const NATIVE = {
  ios: { dir: ['ios'], depth: 3, files: /^AppDelegate\.(?:swift|mm|m)$/u, roots: [/BundleRoot:\s*@?"([^"]+)"/gu], unnamed: null },
  android: { dir: ['android', 'app', 'src', 'main'], depth: 8, files: /^MainApplication\.(?:kt|java)$/u, roots: [/jsMainModulePath\s*=\s*"([^"]+)"/gu, /getJSMainModuleName\(\)[^"]*?"([^"]+)"/gu], unnamed: 'index' },
}

// The files of `dir` whose names match `files`, and of its directories,
// so deep, but those no project's own (Pods, build output, node_modules,
// a hidden one).
function filesOf(dir, files, depth) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue
    if (entry.isDirectory() && depth > 0) found.push(...filesOf(join(dir, entry.name), files, depth - 1))
    else if (entry.isFile() && files.test(entry.name)) found.push(join(dir, entry.name))
  }
  return found
}

// The bundle roots the project's native project of `platform` names; of
// none, or of one that names none, null.
function namedOf(projectRoot, platform) {
  const { dir, depth, files, roots, unnamed } = NATIVE[platform]
  const named = new Set()
  for (const path of filesOf(join(projectRoot, ...dir), files, depth)) {
    let code
    try {
      code = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const found = roots.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]))
    for (const root of found.length > 0 ? found : unnamed === null ? [] : [unnamed]) named.add(root)
  }
  return named.size === 0 ? null : [...named]
}

// Whether the project has a file of the bundle root: `index` of an index.js,
// an index.tsx, an index.ios.js.
function exists(projectRoot, root) {
  try {
    return readdirSync(join(projectRoot, dirname(root))).some((name) => name.startsWith(`${basename(root)}.`))
  } catch {
    return false
  }
}

// -> { request, several }: the request of the project's one bundle, for
// `platform`, dev (bundle-url.js's bundleRequest()'s), or null; and of a
// project of several, their entries ('./index'), else [].
export function oneBundleOf(projectRoot, platform) {
  const named = (NATIVE[platform] === undefined ? null : namedOf(projectRoot, platform)) ?? ['index']
  const entries = [...new Set(named.map((root) => root.replace(/^\.?\//u, '')))].filter((root) => exists(projectRoot, root)).map((root) => `./${root}`)
  if (entries.length !== 1) return { request: null, several: entries.length > 1 ? entries : [] }
  return { request: { kind: 'bundle', entryFile: entries[0], platform, dev: true, minify: false, shallow: false }, several: [] }
}

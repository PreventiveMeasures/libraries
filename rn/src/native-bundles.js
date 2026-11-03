// The bundle a project's app asks for, as its native project names it: the iOS AppDelegate's bundle root, or
// the Android MainApplication's getJSMainModuleName() or jsMainModulePath ("index" if unnamed, as React Native's
// DefaultReactHost has it). Without a native project, or one naming none, the project's index.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Directories that hold none of the project's own native code.
const SKIPPED = new Set(['Pods', 'build', 'node_modules'])
const NATIVE = {
  ios: { dir: ['ios'], depth: 3, files: /^AppDelegate\.(?:swift|mm|m)$/u, roots: [/BundleRoot:\s*@?"([^"]+)"/gu], unnamed: [] },
  android: { dir: ['android', 'app', 'src', 'main'], depth: 8, files: /^MainApplication\.(?:kt|java)$/u, roots: [/jsMainModulePath\s*=\s*"([^"]+)"/gu, /getJSMainModuleName\(\)[^"]*?"([^"]+)"/gu], unnamed: ['index'] },
}

// The files under `dir`, down to `depth`, whose names match `files`; skipping SKIPPED and hidden directories.
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

// The bundle roots the native project of `platform` names, or null if it names none.
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
    for (const root of found.length > 0 ? found : unnamed) named.add(root)
  }
  return named.size === 0 ? null : [...named]
}

// Whether the project has a file for the bundle root with any extension: index.js, index.ios.tsx.
function exists(projectRoot, root) {
  try {
    return readdirSync(join(projectRoot, dirname(root))).some((name) => name.startsWith(`${basename(root)}.`))
  } catch {
    return false
  }
}

// `request`: the dev bundle request of the project's one bundle for `platform`, or null. `several`: the
// entries ('./index') if there are more than one, else [].
export function oneBundleOf(projectRoot, platform) {
  const named = (NATIVE[platform] === undefined ? null : namedOf(projectRoot, platform)) ?? ['index']
  const entries = [...new Set(named.map((root) => root.replace(/^\.?\//u, '')))].filter((root) => exists(projectRoot, root)).map((root) => `./${root}`)
  if (entries.length !== 1) return { request: null, several: entries }
  return { request: { kind: 'bundle', entryFile: entries[0], platform, dev: true, minify: false, shallow: false }, several: [] }
}

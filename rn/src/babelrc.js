// Babel's .babelrc lookup for one build, reading each directory once.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// (filename) => whether Babel's .babelrc lookup (Metro's enableBabelRCLookup) finds a config for the file:
// a .babelrc*, a .babelignore or a package.json Babel takes, from its directory up to its package's root.
// Where it finds none, Babel loads the same options with babelrc: false.
export function babelrcFinder() {
  const known = new Map()
  const finds = (directory) => {
    // Babel stops short of node_modules.
    if (basename(directory) === 'node_modules') return false
    if (known.has(directory)) return known.get(directory)
    let names = []
    try {
      names = readdirSync(directory)
    } catch {}
    const parent = dirname(directory)
    const found = names.some((name) => name.startsWith('.babelrc') || name === '.babelignore') || (names.includes('package.json') ? babelOf(join(directory, 'package.json')) : parent !== directory && finds(parent))
    known.set(directory, found)
    return found
  }
  return (filename) => finds(dirname(filename))
}

// Whether Babel takes a package.json as a config: it has a `babel` key, or is invalid (Babel throws on it).
function babelOf(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.babel !== undefined
  } catch {
    return true
  }
}

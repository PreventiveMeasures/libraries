// Babel's .babelrc lookup for one build, reading each directory once.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// -> (filename) => whether the lookup finds a .babelrc*, .babelignore or package.json Babel takes, up to the
// file's package root. Where it finds none, babelrc: false loads the same options.
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

// Babel takes a package.json with a `babel` key, and throws on an invalid one.
function babelOf(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.babel !== undefined
  } catch {
    return true
  }
}

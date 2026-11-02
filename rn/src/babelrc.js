// Babel's .babelrc lookup, of a build: what it would find of each file,
// each directory read once.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// (filename) => whether Babel's .babelrc lookup (babelrc: true, Metro's
// enableBabelRCLookup) finds anything of the file: of the directories from
// the file's up to its package's (the first with a package.json, short of a
// node_modules), a .babelrc (by any extension) or .babelignore in one, or a
// package.json with a `babel` key, or one Babel fails on. Babel looks for
// each anew for each file, and its mtime; here each directory is read once,
// as of a build whose files don't change as it runs. Where it finds none,
// Babel, told babelrc: false, loads the same options.
export function babelrcFinder() {
  const known = new Map()
  const finds = (directory) => {
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

// Whether Babel takes a package.json for a config: its `babel` key, or none
// it can read, which it fails on.
function babelOf(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    return manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.babel !== undefined
  } catch {
    return true
  }
}

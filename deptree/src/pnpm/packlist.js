// The files pnpm installs of a directory a `file:` dependency names, as its
// directory fetcher picks them: with npm-packlist 5.1.3 for pnpm 10 and
// 10.0.4 for pnpm 11, with its own port, fs-packlist, for pnpm 12. Only
// their built-in rules are followed, case-folded for npm-packlist and as
// spelled for pnpm 12. A directory they do not describe is refused: one
// with ignore files, `files` or bundled dependencies; one with a link,
// which the two pass over differently; one where a file the rules leave
// out is kept anyway (a readme or license, or what the package.json
// names), as the two keep those differently; and a mode other than 0o644
// or 0o755, which linking a bin would change otherwise than fixBin does.

import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readBytes } from '../project.js'

// npm-packlist's names left out wherever they are, matched folded.
const ANYWHERE = /^(?:\.git|\.svn|\.hg|cvs|\.npmrc|\.ds_store|npm-debug\.log|\.npmignore|\.gitignore|\._.*|\..*\.swp|.*\.orig)$/u

// npm-packlist's rules anchored to the directory they are read in: the top
// for npm-packlist 5, and every directory for 10, which rereads them.
const anchored = (names, directory) => (names.length === 1 && (names[0] === '.lock-wscript' || names[0].startsWith('.wafpickle-') || (directory && names[0] === 'archived-packages')))
  || (names.length === 2 && names[0] === 'build' && names[1] === 'config.gypi')

// The names left out at the top alone.
const TOP = ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
const TOP_11 = [...TOP, 'bun.lockb']

// pnpm 12's rules: the names left out wherever they are, and the files.
const VCS = new Set(['.git', '.svn', '.hg', 'CVS'])
const CRUFT = new Set(['.npmrc', 'npm-debug.log', '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

// `names` is the entry's path from the package's directory, split, and
// `directory` whether it is one.
function leftOut12(names, directory) {
  const name = names.at(-1)
  return VCS.has(name) || (names.length === 1 && name === 'node_modules') || (!directory && (CRUFT.has(name) || name.endsWith('.orig')))
}

// Whether pnpm 12 leaves out the file at `path` even where `main` or `bin`
// names it: by all its rules but node_modules's.
function alwaysLeftOut12(path) {
  const names = path.split('/')
  const name = names.at(-1)
  return names.some((each) => VCS.has(each)) || CRUFT.has(name) || name.endsWith('.orig')
}

// As leftOut12, for npm-packlist as pnpm `major` runs it.
function leftOutByNpm(names, directory, major) {
  const folded = names.map((name) => name.toLowerCase())
  const readIn = major >= 11 ? folded.map((_, i) => folded.slice(i)) : [folded]
  return ANYWHERE.test(folded.at(-1)) || readIn.some((path) => anchored(path, directory))
    || (folded.length === 1 && (major >= 11 ? TOP_11 : TOP).includes(folded[0]))
}

// npm-packlist's names it keeps, whatever else says.
const MUST_HAVE = /^(?:readme|copying|license|licence)(?:\..*[^~$])?$/iu

// The paths, lowercased, a package.json names that pnpm `major` may keep
// whatever its rules say: `main`, `browser` and `bin`, or with pnpm 12
// `main` and `bin` where only the node_modules rule leaves them out.
function namedByManifest(manifest, major) {
  const { main, browser, bin } = manifest
  const bins = typeof bin === 'string' ? [bin] : Object.values(bin ?? {})
  const paths = (major >= 12 ? [main, ...bins] : [main, browser, ...bins]).filter((path) => typeof path === 'string').map((path) => join('.', path))
  return (major >= 12 ? paths.filter((path) => !alwaysLeftOut12(path)) : paths).map((path) => path.toLowerCase())
}

// An empty list bundles none, with either npm-packlist.
const bundles = (list) => Boolean(list) && !(Array.isArray(list) && list.length === 0)

// The files picked of the package at `dir` in `project`, as { data, mode }
// by their paths from it.
export function packDirectory(project, dir, manifest, major, where) {
  if (manifest.files !== undefined) throw new DeptreeError('its package.json has `files`, which npm-packlist picks the files pnpm installs by, and which is not followed here', where)
  if (bundles(manifest.bundleDependencies) || bundles(manifest.bundledDependencies)) throw new DeptreeError('a directory with bundled dependencies is not supported', where)
  const named = namedByManifest(manifest, major)
  const leftOut = major >= 12 ? leftOut12 : (names, directory) => leftOutByNpm(names, directory, major)
  const files = new Map()
  const visit = (names) => {
    for (const entry of project.readdir(['', dir, ...names].join('/'))) {
      const at = [...names, entry]
      const rel = at.join('/')
      const here = `${where}: ${quote(rel)}`
      const { type, mode } = project.lstat(`/${dir}/${rel}`)
      if (type === 'symlink') throw new DeptreeError('a link in a directory pnpm installs a copy of is not supported', here)
      if (entry === '.npmignore' || entry === '.gitignore') throw new DeptreeError(`${entry}'s rules, which npm-packlist picks the files pnpm installs by, are not followed here`, here)
      if (major < 12 && names.length === 0 && entry !== 'node_modules' && entry.toLowerCase() === 'node_modules') throw new DeptreeError('a name that is node_modules but for its case is kept by pnpm 10 and left out by pnpm 11', here)
      if (major < 12 && entry.includes('*')) continue
      if (leftOut(at, type === 'directory')) {
        const folded = rel.toLowerCase()
        if ((major < 12 && MUST_HAVE.test(entry)) || named.some((kept) => kept === folded || kept.startsWith(`${folded}/`))) {
          throw new DeptreeError('whether pnpm installs it turns on rules of npm-packlist not followed here', here)
        }
        continue
      }
      if (type === 'directory') visit(at)
      else if (mode !== 0o644 && mode !== 0o755) throw new DeptreeError(`its mode, ${mode.toString(8)}, is not 644 or 755, which is not supported`, here)
      else files.set(rel, { data: readBytes(project, `/${dir}/${rel}`), mode })
    }
  }
  visit([])
  return files
}

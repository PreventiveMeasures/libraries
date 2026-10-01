// The files pnpm installs of a directory a `file:` dependency names: its
// directory fetcher picks them with npm-packlist — 5.1.3 for pnpm 10,
// 10.0.4 for pnpm 11, its own port of it (fs-packlist) for pnpm 12 — and
// hardlinks or copies them into the tree (tree.js). Only the built-in
// rules are followed here. npm-packlist's leave out, by name and whatever
// its case:
//
//  - anywhere, `.git`, `.svn`, `.hg`, `CVS`, `.npmrc`, `.DS_Store`,
//    `npm-debug.log`, `.npmignore`, `.gitignore`, and a name starting
//    with `._`, or `.` and ending in `.swp`, or ending in `.orig`, with
//    everything in it;
//  - at the top, and with pnpm 11 in every directory, `.lock-wscript`,
//    `.wafpickle-*`, `build/config.gypi` and what is in
//    `archived-packages`;
//  - at the top, `node_modules` and the lockfiles `package-lock.json`,
//    `yarn.lock`, `pnpm-lock.yaml` and, with pnpm 11, `bun.lockb`;
//
// and every name with a `*` in it. pnpm 12's leave out, by name as it is
// spelled:
//
//  - anywhere, `.git`, `.svn`, `.hg` and `CVS`, with everything in them,
//    and a file `.npmrc`, `npm-debug.log`, `.DS_Store`,
//    `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`, or one whose
//    name ends in `.orig`;
//  - at the top, `node_modules`.
//
// A directory those do not describe is refused: one with a .npmignore
// or .gitignore in it, or a package.json with `files` or bundled
// dependencies, whose rules are not followed here; one with a link in
// it, which the two pass over differently; and one where a file those
// leave out is one npm-packlist would keep, a readme, copying, license or
// licence file, or one `main`, `browser` or `bin` names, as the two keep
// them differently, or, with pnpm 12, one in node_modules that `main` or
// `bin` names, the only file it keeps of those its rules leave out. So is
// a file whose mode is not 0o644 or 0o755, which linking a bin would
// change otherwise than fixBin has it.

import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readBytes } from './project.js'

// The rules each name is held to, folded, wherever it is.
const ANYWHERE = /^(?:\.git|\.svn|\.hg|cvs|\.npmrc|\.ds_store|npm-debug\.log|\.npmignore|\.gitignore|\._.*|\..*\.swp|.*\.orig)$/u

// The rules held to the path, by its names folded, from the directory they
// are read in: the top for npm-packlist 5, and every directory for
// npm-packlist 10, which reads them again in each.
const anchored = (names, directory) => (names.length === 1 && (names[0] === '.lock-wscript' || names[0].startsWith('.wafpickle-') || (directory && names[0] === 'archived-packages')))
  || (names.length === 2 && names[0] === 'build' && names[1] === 'config.gypi')

// The names left out at the top alone.
const TOP = ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']
const TOP_11 = [...TOP, 'bun.lockb']

// pnpm 12's rules: the names left out wherever they are, and the files.
const VCS = new Set(['.git', '.svn', '.hg', 'CVS'])
const CRUFT = new Set(['.npmrc', 'npm-debug.log', '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

// Whether pnpm 12's rules leave out the entry at `names`, its path from the
// package's directory by name, which is a directory where `directory`.
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

// Whether npm-packlist's built-in rules, as pnpm `major` runs it, leave out
// the entry at `names`, as for leftOut12.
function leftOutByNpm(names, directory, major) {
  const folded = names.map((name) => name.toLowerCase())
  const readIn = major >= 11 ? folded.map((_, i) => folded.slice(i)) : [folded]
  return ANYWHERE.test(folded.at(-1)) || readIn.some((path) => anchored(path, directory))
    || (folded.length === 1 && (major >= 11 ? TOP_11 : TOP).includes(folded[0]))
}

// npm-packlist's names it keeps, whatever else says.
const MUST_HAVE = /^(?:readme|copying|license|licence)(?:\..*[^~$])?$/iu

// The paths a package.json's main, browser and bin name, from its
// directory, whatever their case, that pnpm `major` may keep whatever its
// rules say: with pnpm 12, those main and bin name that its rules but
// node_modules's do not leave out.
function namedByManifest(manifest, major) {
  const { main, browser, bin } = manifest
  const bins = typeof bin === 'string' ? [bin] : Object.values(bin ?? {})
  const paths = (major >= 12 ? [main, ...bins] : [main, browser, ...bins]).filter((path) => typeof path === 'string').map((path) => join('.', path))
  return (major >= 12 ? paths.filter((path) => !alwaysLeftOut12(path)) : paths).map((path) => path.toLowerCase())
}

// Whether a package.json's list of bundled dependencies may name any: an
// empty one bundles none, with either npm-packlist.
const bundles = (list) => Boolean(list) && !(Array.isArray(list) && list.length === 0)

// The files of the package at `dir` of `project` npm-packlist picks, with
// their data and modes, by their paths from it; `manifest` is its
// package.json as parsed.
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

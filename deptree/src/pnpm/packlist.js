// The files pnpm installs of a directory a `file:` dependency names: its
// directory fetcher picks them with npm-packlist — 5.1.3 for pnpm 10,
// 10.0.4 for pnpm 11 — and hardlinks them into the tree. Only
// npm-packlist's built-in rules are followed here, which leave out, by
// name and whatever its case:
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
// and every name with a `*` in it. A directory those do not describe is
// refused: one with a .npmignore or .gitignore in it, or a package.json
// with `files` or bundled dependencies, whose rules are not followed
// here; one with a link in it, which the two pass over differently; and
// one where a file those leave out is one npm-packlist would keep, a
// readme, copying, license or licence file, or one `main`, `browser` or
// `bin` names, as the two keep them differently. So is a file whose mode
// is not 0o644 or 0o755, which linking a bin would change otherwise than
// fixBin has it.

import { join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'

const ANYWHERE = new Set(['.git', '.svn', '.hg', 'cvs', '.npmrc', '.ds_store', 'npm-debug.log', '.npmignore', '.gitignore'])
const leftOutAnywhere = (name) => ANYWHERE.has(name) || name.startsWith('._') || /^\..*\.swp$/u.test(name) || name.endsWith('.orig')

const TOP = new Set(['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])

// Whether the built-in rules leave out the entry at `names`, the path of
// it from the package's directory by name, which is a directory where
// `directory`. npm-packlist 10 reads its rules anchored at the top again
// in every directory it walks; npm-packlist 5 at the top alone.
function leftOut(names, directory, major) {
  const name = names.at(-1).toLowerCase()
  if (leftOutAnywhere(name)) return true
  const top = names.length === 1
  if ((top || major >= 11) && (name === '.lock-wscript' || name.startsWith('.wafpickle-') || (directory && name === 'archived-packages'))) return true
  if ((names.length === 2 || (major >= 11 && names.length > 2)) && names.at(-2).toLowerCase() === 'build' && name === 'config.gypi') return true
  return top && (TOP.has(name) || (major >= 11 && name === 'bun.lockb'))
}

// npm-packlist's names it keeps, whatever else says.
const MUST_HAVE = /^(?:readme|copying|license|licence)(?:\..*[^~$])?$/iu

// The paths a package.json's main, browser and bin name, from its
// directory, whatever their case.
function namedByManifest(manifest) {
  const { main, browser, bin } = manifest
  const paths = [main, browser, ...typeof bin === 'string' ? [bin] : Object.values(bin ?? {})]
  return paths.filter((path) => typeof path === 'string').map((path) => join('.', path).toLowerCase())
}

// The files of the package at `dir` of `vfs` npm-packlist picks, with
// their data and modes, by their paths from it; `manifest` is its
// package.json as parsed.
export function packDirectory(vfs, dir, manifest, major, where) {
  if (manifest.files !== undefined) throw new DeptreeError('its package.json has `files`, which npm-packlist picks the files pnpm installs by, and which is not followed here', where)
  if (manifest.bundleDependencies || manifest.bundledDependencies) throw new DeptreeError('a directory with bundled dependencies is not supported', where)
  const named = namedByManifest(manifest)
  const files = new Map()
  const visit = (names) => {
    const path = names.join('/')
    for (const entry of vfs.readdir(`/${dir}${path === '' ? '' : `/${path}`}`)) {
      const at = [...names, entry]
      const rel = at.join('/')
      const here = `${where}: ${quote(rel)}`
      const { type, mode } = vfs.lstat(`/${dir}/${rel}`)
      if (type === 'symlink') throw new DeptreeError('a link in a directory pnpm installs a copy of is not supported', here)
      if (entry === '.npmignore' || entry === '.gitignore') throw new DeptreeError(`${entry}'s rules, which npm-packlist picks the files pnpm installs by, are not followed here`, here)
      if (names.length === 0 && entry !== 'node_modules' && entry.toLowerCase() === 'node_modules') throw new DeptreeError('a name that is node_modules but for its case is kept by pnpm 10 and left out by pnpm 11', here)
      if (entry.includes('*')) continue
      if (leftOut(at, type === 'directory', major)) {
        const folded = rel.toLowerCase()
        if (MUST_HAVE.test(entry) || named.some((kept) => kept === folded || kept.startsWith(`${folded}/`))) {
          throw new DeptreeError('whether pnpm installs it turns on rules of npm-packlist not followed here', here)
        }
        continue
      }
      if (type === 'directory') visit(at)
      else if (mode !== 0o644 && mode !== 0o755) throw new DeptreeError(`its mode, ${mode.toString(8)}, is not 644 or 755, which is not supported`, here)
      else files.set(rel, { data: vfs.readFile(`/${dir}/${rel}`), mode })
    }
  }
  visit([])
  return files
}

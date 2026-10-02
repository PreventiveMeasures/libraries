// The files pnpm's directory fetcher installs of a `file:` dependency, as its
// packlist picks them: npm-packlist 5.1.3 for pnpm 9 and 10, 10.0.4 for pnpm
// 11, and pnpm 12's own port of it, by package.json's `files`, `main` and
// `bin`, the .npmignore and .gitignore files where they read them, and their
// own rules. Of glob syntax only `*`, `?` and `**` are followed, which they
// all read alike. Refused are a link the walk comes on, which they treat
// differently, and a mode a checkout does not have under umask 022 or 002.

import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { normalize } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { readBytes } from '../project.js'
import { bytesOf, gitignoreGlob, matched, matchedOrParents } from './gitignore.js'
import { pack10, pack11 } from './npm-packlist.js'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const MODES = new Set([0o644, 0o664, 0o755, 0o775])

// How deep a directory is walked: each entry is matched against the rules
// of every directory above it, which takes time growing with the cube.
const MAX_DEPTH = 100

// The directory by paths from it, `.` parts and all, which refuses a link
// on the way to anything it is asked of.
function viewOf(project, dir, where) {
  const types = new Map()
  const absolute = (rel) => `/${[dir, ...rel.split('/').filter((part) => part !== '' && part !== '.')].filter(Boolean).join('/')}`
  const type = (rel) => {
    const path = absolute(rel)
    if (!types.has(path)) {
      let found
      try {
        found = project.lstat(path).type
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      }
      if (found === 'symlink') throw new DeptreeError('a link in a directory pnpm installs a copy of is not supported', `${where}: ${quote(normalize(rel))}`)
      types.set(path, found)
    }
    return types.get(path)
  }
  const view = {
    // What `rel` is once normalized, as path.join would; nothing outside.
    type(rel) {
      const normal = normalize(rel)
      if (normal === '..' || normal.startsWith('../')) return undefined
      const parts = normal.split('/').filter((part) => part !== '' && part !== '.')
      for (let i = 1; i < parts.length; i++) if (type(parts.slice(0, i).join('/')) !== 'directory') return undefined
      const found = parts.length === 0 ? 'directory' : type(parts.join('/'))
      return rel.endsWith('/') && found !== 'directory' ? undefined : found
    },
    entries(rel) {
      if (view.type(rel) !== 'directory') return undefined
      if (normalize(rel).split('/').length > MAX_DEPTH) throw new DeptreeError(`a directory nested more than ${MAX_DEPTH} deep, each of whose entries the packlists match against the rules of every directory above it, is not supported`, `${where}: ${quote(normalize(rel))}`)
      return project.readdir(absolute(rel))
    },
    text(rel, here) {
      if (view.type(rel) !== 'file') throw new DeptreeError('it is not a file, which pnpm fails to read', here)
      try {
        return decoder.decode(readBytes(project, absolute(rel)))
      } catch {
        throw new DeptreeError('it is not UTF-8, which is not supported', here)
      }
    },
    bytes: (rel) => readBytes(project, absolute(rel)),
    lstat: (rel) => project.lstat(absolute(rel)),
  }
  return view
}

// pnpm 12's lists of names.
const VCS = new Set(['.git', '.svn', '.hg', 'CVS'])
const CRUFT = new Set(['.npmrc', 'npm-debug.log', '.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'])
const alwaysExcluded = (rel) => CRUFT.has(rel.split('/').at(-1)) || rel.split('/').some((part) => VCS.has(part)) || rel.endsWith('.orig')
const asciiLower = (name) => name.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase())
const alwaysIncluded = (name) => asciiLower(name) === 'package.json' || ['readme', 'license', 'licence'].some((start) => asciiLower(name).startsWith(start))
const ALTERNATES = new Set(['package.yaml', 'package.json5'])
const fieldPath = (path) => path.replace(/^(?:\.\/)+/u, '').replace(/^\/+/u, '')

// pnpm 12 makes one regexp of the globs of an ignore file, or of `files`,
// and drops them all where it grows too large, which none does below twice
// this many bytes of them.
const MAX_GLOBS_12 = 16 * 1024
const checkGlobs12 = (lines, what, where) => {
  if (lines.reduce((sum, line) => sum + bytesOf(line).length + 1, 0) > MAX_GLOBS_12) throw new DeptreeError(`${what} of more than ${MAX_GLOBS_12 / 1024} KiB, all of which pnpm 12 may drop as too large a regexp, is not supported`, where)
}

// pnpm 12's `files` allowlist: its matcher, or undefined where no entry is
// one, and the files it names outright.
function filesOf12(view, files, where) {
  checkGlobs12(files ?? [], 'its package.json has `files`', where)
  const globs = []
  for (const entry of files ?? []) {
    const path = fieldPath(entry)
    if (path !== '') globs.push(gitignoreGlob(path.startsWith('!') ? path : `/${path}`, `${where}: files[${quote(entry)}]`))
  }
  const named = new Set((files ?? []).filter((entry) => !entry.startsWith('!') && !entry.endsWith('/') && !/[*?[\]{}]/u.test(entry)).map(fieldPath).filter((path) => path !== '' && !path.split('/').includes('..') && view.type(path) === 'file'))
  return { globs: globs.length > 0 ? globs : undefined, named }
}

function includedBy12(globs, rel, named) {
  if (globs.some((glob) => glob.whitelist) && !named.has(rel)) {
    const parts = rel.split('/')
    for (let i = parts.length - 1; i >= 0; i--) if (matched(globs, parts.slice(0, i).join('/'), true) === 'whitelist') return false
  }
  return matchedOrParents(globs, rel, false) === 'ignore'
}

// The ignore crate's walk: each directory's .npmignore and, unless the top
// has one, .gitignore, the nearest to match a path deciding, an .npmignore's
// before any .gitignore's. Neither is read where `files` has a matcher.
function walk12(view, { globs }, where) {
  const useGit = view.type('.npmignore') !== 'file'
  const found = []
  const visit = (rel, stack) => {
    const names = view.entries(rel)
    const own = { dir: rel }
    for (const [key, name] of [['custom', '.npmignore'], ['git', '.gitignore']]) {
      if (globs === undefined && (key === 'custom' || useGit) && names.includes(name)) {
        const path = rel === '' ? name : `${rel}/${name}`
        const here = `${where}: ${quote(path)}`
        const lines = view.text(path, here).split('\n')
        checkGlobs12(lines, 'an ignore file', here)
        own[key] = lines.map((line, i) => (i === 0 ? line.replace(/^\uFEFF/u, '') : line).replace(/\r$/u, '')).map((line) => gitignoreGlob(line, here)).filter(Boolean)
      }
    }
    const chain = [own, ...stack]
    for (const name of names) {
      const path = rel === '' ? name : `${rel}/${name}`
      if ((rel === '' && name === 'node_modules') || VCS.has(name)) continue
      const isDir = view.type(path) === 'directory'
      const verdict = (key) => chain.map((level) => level[key] === undefined ? undefined : matched(level[key], level.dir === '' ? path : path.slice(level.dir.length + 1), isDir)).find(Boolean)
      if ((verdict('custom') ?? verdict('git')) === 'ignore') continue
      if (isDir) visit(path, chain)
      else found.push(path)
    }
  }
  visit('', [])
  return found
}

function pack12(view, manifest, where) {
  const files = Array.isArray(manifest.files) ? filesOf12(view, manifest.files, where) : { named: new Set() }
  const main = typeof manifest.main === 'string' ? [manifest.main] : []
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : manifest.bin !== null && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? Object.values(manifest.bin).filter((bin) => typeof bin === 'string') : []
  const fields = [...main, ...bins].map(fieldPath)
  const kept = new Set(walk12(view, files, where).filter((rel) => !alwaysExcluded(rel) && !rel.startsWith('node_modules/')
    && (files.globs === undefined || includedBy12(files.globs, rel, files.named) || (!rel.includes('/') && alwaysIncluded(rel)) || fields.includes(rel))))
  for (const name of view.entries('')) {
    if (!alwaysExcluded(name) && (alwaysIncluded(name) || ALTERNATES.has(asciiLower(name))) && view.type(name) === 'file') kept.add(name)
  }
  // A main or bin path that stays inside, kept as it is spelled.
  for (const path of fields) {
    const parts = path.split('/')
    if (path === '' || path.includes('\\') || parts.includes('..') || parts[0] === '.' || alwaysExcluded(path) || view.type(path) !== 'file') continue
    if (parts.some((part) => part === '' || part === '.') || parts[0] === 'node_modules') throw new DeptreeError(`main or bin names ${quote(path)}, which pnpm 12 keeps as it is spelled, and which is not supported`, where)
    kept.add(path)
  }
  return kept
}

const bundles = (list) => Boolean(list) && !(Array.isArray(list) && list.length === 0)

function checkManifest(manifest, pnpm, view, where) {
  const { files, bin } = manifest
  if (bundles(manifest.bundleDependencies) || bundles(manifest.bundledDependencies)) throw new DeptreeError('a directory with bundled dependencies is not supported', where)
  if (files !== undefined && files !== null && !(Array.isArray(files) && files.every((entry) => typeof entry === 'string'))) throw new DeptreeError('its package.json has `files` that is not a list of strings, which is not supported', where)
  if (Array.isArray(bin) && bin.some((path) => typeof path !== 'string') && !pnpm.startsWith('11.') && !pnpm.startsWith('12.')) throw new DeptreeError('its package.json has a bin list with other than strings, which npm-packlist then reads unnormalized, and which is not supported', where)
  if (!pnpm.startsWith('11.')) return
  if (bin !== null && typeof bin === 'object' && Object.values(bin).some((path) => typeof path !== 'string')) throw new DeptreeError('its package.json has a bin that is not a string, which pnpm 11 fails on', where)
  if (compareVersions(pnpm, '11.28.0') < 0 && view.text('package.json', where).startsWith('\uFEFF')) throw new DeptreeError('its package.json starts with a byte order mark, which pnpm 11 fails on before 11.28', where)
}

// `version` is the version that installs, as host.pnpm gives it: `v11.28.2`
// is read as 11.28.2.
export function packDirectory(project, dir, manifest, version, where) {
  const pnpm = valid(version)
  const view = viewOf(project, dir, where)
  checkManifest(manifest, pnpm, view, where)
  const major = Number(pnpm.split('.')[0])
  const kept = major >= 12 ? pack12(view, manifest, where)
    : major === 11 ? pack11(view, manifest, where, compareVersions(pnpm, '11.28.0') >= 0)
      : pack10(view, view.text('package.json', where).startsWith('\uFEFF') ? undefined : manifest, where, major === 10 && compareVersions(pnpm, '10.31.0') >= 0 ? '5.1.9' : '5.1.6')
  const files = new Map()
  for (const rel of [...new Set([...kept].map((path) => path.replace(/^\.\//u, '')))].sort()) {
    const here = `${where}: ${quote(rel)}`
    if (rel.split('/').some((part) => part === '' || part === '.')) throw new DeptreeError('pnpm keeps it as a pattern spells it, which is not supported', here)
    const { mode } = view.lstat(rel)
    if (!MODES.has(mode)) throw new DeptreeError(`its mode, ${mode.toString(8)}, is not 644, 664, 755 or 775, which is not supported`, here)
    files.set(rel, { data: view.bytes(rel), mode })
  }
  return files
}
